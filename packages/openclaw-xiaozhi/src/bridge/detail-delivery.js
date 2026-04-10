import { spawn } from "node:child_process";

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDeliveryBinding(binding) {
  if (!binding || typeof binding !== "object") {
    return null;
  }

  const enabled = Boolean(binding.enabled);
  const deliveryChannel = trimString(binding.deliveryChannel);
  const accountId = trimString(binding.accountId);
  const target = trimString(binding.target);
  const threadId = trimString(binding.threadId);
  const format = normalizeDeliveryFormat(binding.format);

  if (!enabled || !deliveryChannel || !target) {
    return null;
  }

  return {
    enabled: true,
    deliveryChannel,
    accountId: accountId || undefined,
    target,
    threadId: threadId || undefined,
    format
  };
}

function normalizeDeliveryFormat(value) {
  const format = trimString(value) || "text";
  if (format === "card") {
    return "card";
  }
  return "text";
}

function normalizeMediaUrls(params) {
  const urls = [];
  const singleMedia = trimString(params?.mediaUrl);
  if (singleMedia) {
    urls.push(singleMedia);
  }
  if (Array.isArray(params?.mediaUrls)) {
    for (const item of params.mediaUrls) {
      const value = trimString(item);
      if (value) {
        urls.push(value);
      }
    }
  }
  return urls;
}

function normalizeCardPayload(params) {
  const rawCard = params?.card;
  if (rawCard && typeof rawCard === "object") {
    return rawCard;
  }

  const cardText = trimString(rawCard);
  if (!cardText) {
    return null;
  }

  try {
    return JSON.parse(cardText);
  } catch {
    throw new Error("card 必须是 JSON 对象或可解析的 JSON 字符串");
  }
}

function buildMessageText(params) {
  const text = trimString(params?.text);
  const title = trimString(params?.title);

  if (!text) {
    return "";
  }
  if (!title) {
    return text;
  }
  return `${title}\n\n${text}`;
}

function runOpenClawCommand(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `openclaw message send 失败(code=${code}): ${stderr.trim() || stdout.trim() || "unknown error"}`
        )
      );
    });
  });
}

export async function deliverDetailMessage({ binding, params, logger }) {
  const normalizedBinding = normalizeDeliveryBinding(binding);
  if (!normalizedBinding) {
    throw new Error("当前会话未配置可用的 detail delivery 绑定");
  }

  const format = normalizeDeliveryFormat(params?.format || normalizedBinding.format);
  const message = buildMessageText(params);
  const card = normalizeCardPayload(params);
  const mediaUrls = normalizeMediaUrls(params);

  if (!message && !card && mediaUrls.length === 0) {
    throw new Error("text、card、mediaUrl 至少需要提供一种");
  }

  const openclawBin = trimString(process.env.OPENCLAW_BIN) || "openclaw";
  const args = [
    "message",
    "send",
    "--json",
    "--channel",
    normalizedBinding.deliveryChannel,
    "--target",
    normalizedBinding.target
  ];

  if (normalizedBinding.accountId) {
    args.push("--account", normalizedBinding.accountId);
  }
  if (normalizedBinding.threadId) {
    args.push("--thread-id", normalizedBinding.threadId);
  }
  if (card || format === "card") {
    args.push("--card", JSON.stringify(card || { body: [{ type: "TextBlock", text: message }] }));
  } else if (message) {
    args.push("--message", message);
  }
  if (mediaUrls.length > 0) {
    args.push("--media", mediaUrls[0]);
  }

  logger?.info?.(
    `[xiaozhi] deliver detail channel=${normalizedBinding.deliveryChannel} account=${normalizedBinding.accountId || "-"} target=${normalizedBinding.target} thread=${normalizedBinding.threadId || "-"} format=${format}`
  );

  const { stdout, stderr } = await runOpenClawCommand(openclawBin, args);
  const output = trimString(stdout);
  let parsed = null;
  if (output) {
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = null;
    }
  }

  return {
    ok: true,
    deliveryChannel: normalizedBinding.deliveryChannel,
    accountId: normalizedBinding.accountId || "",
    target: normalizedBinding.target,
    threadId: normalizedBinding.threadId || "",
    format,
    mediaCount: mediaUrls.length,
    truncatedMediaCount: mediaUrls.length > 1 ? mediaUrls.length - 1 : 0,
    result: parsed,
    stderr: trimString(stderr)
  };
}
