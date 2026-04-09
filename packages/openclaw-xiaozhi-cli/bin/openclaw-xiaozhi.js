#!/usr/bin/env node

import process from "node:process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_PLUGIN_SPEC =
  packageJson?.openclawXiaozhi?.pluginPackage || "@galaxyxieyu/xiaozhi";

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function assertSimpleAccountId(accountId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error("account id 只能包含字母、数字、下划线和中划线");
  }
}

async function promptValue(rl, label, fallback = "", { secret = false } = {}) {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = await rl.question(`${label}${suffix}: `, secret ? {
    // Some Linux terminals do not reliably block on an empty prompt string.
    signal: AbortSignal.timeout(10 * 60 * 1000)
  } : undefined);
  return value.trim() || fallback;
}

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function resolveValue(rl, providedValue, label, fallback = "", promptOptions = {}) {
  if (hasValue(providedValue)) {
    return providedValue.trim();
  }
  return promptValue(rl, label, fallback, promptOptions);
}

function buildAdminUrl(serverUrl, path) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  url.pathname = path;
  url.search = "";
  return url.toString();
}

async function issueBridgeToken({ serverUrl, adminKey, accountId, defaultAgentId, name, bridgeId }) {
  const response = await fetch(
    buildAdminUrl(serverUrl, "/admin/openclaw/issue-bridge-token"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        bridgeId: bridgeId || undefined,
        account: accountId,
        defaultAgentId: defaultAgentId || undefined
      })
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || `签发 bridge token 失败: HTTP ${response.status}`);
  }
  return payload;
}

function runOpenClaw(args) {
  const result = spawnSync("openclaw", args, {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`openclaw ${args.join(" ")} 执行失败`);
  }
}

function runOpenClawCapture(args) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf-8"
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "").trim() || `openclaw ${args.join(" ")} 执行失败`);
  }
  return result.stdout.trim();
}

function tryRunOpenClawCapture(args) {
  try {
    return runOpenClawCapture(args);
  } catch {
    return "";
  }
}

function runOpenClawBestEffort(args) {
  const result = spawnSync("openclaw", args, {
    stdio: "inherit"
  });
  return result.status === 0;
}

function parseJsonFromOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trimStart();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("[plugins]")) {
      continue;
    }
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      continue;
    }
    return JSON.parse(lines.slice(index).join("\n"));
  }
  throw new Error("OpenClaw 未返回可解析的 JSON 输出");
}

function runOpenClawJson(args) {
  return parseJsonFromOutput(runOpenClawCapture(args));
}

function resolvePluginDir(pluginId = "xiaozhi") {
  return path.join(os.homedir(), ".openclaw", "extensions", pluginId);
}

function cleanupExistingPlugin(pluginId = "xiaozhi") {
  const pluginDir = resolvePluginDir(pluginId);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
}

function resolveOpenClawPackageDir() {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  const whichResult = spawnSync(whichCommand, ["openclaw"], {
    encoding: "utf-8"
  });
  if (whichResult.status !== 0) {
    return "";
  }

  const binaries = whichResult.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const binary of binaries) {
    let realBinary = binary;
    try {
      realBinary = fs.realpathSync(binary);
    } catch {
      // ignore and keep the original path
    }

    const candidateDirs = [
      path.resolve(path.dirname(realBinary), "..", "lib", "node_modules", "openclaw"),
      path.resolve(path.dirname(realBinary), "..", "..", "lib", "node_modules", "openclaw"),
      path.resolve(path.dirname(realBinary), "..", "node_modules", "openclaw")
    ];

    for (const candidate of candidateDirs) {
      const pkgPath = path.join(candidate, "package.json");
      if (!fs.existsSync(pkgPath)) {
        continue;
      }
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg?.name === "openclaw") {
          return candidate;
        }
      } catch {
        // ignore malformed candidates
      }
    }
  }

  return "";
}

function resolveOpenClawConfigPath() {
  if (hasValue(process.env.OPENCLAW_CONFIG_PATH)) {
    return path.resolve(process.env.OPENCLAW_CONFIG_PATH.trim());
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function readConfigFile(configPath = resolveOpenClawConfigPath()) {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, "utf-8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function writeConfigFile(config, configPath = resolveOpenClawConfigPath()) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function pruneEmptyObject(parent, key) {
  if (!parent || typeof parent !== "object") {
    return;
  }
  const value = parent[key];
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    delete parent[key];
  }
}

function sanitizeXiaozhiConfig(pluginId = "xiaozhi") {
  const configPath = resolveOpenClawConfigPath();
  const config = readConfigFile(configPath);
  let changed = false;

  if (
    config.channels &&
    typeof config.channels === "object" &&
    Object.prototype.hasOwnProperty.call(config.channels, pluginId)
  ) {
    delete config.channels[pluginId];
    pruneEmptyObject(config, "channels");
    changed = true;
  }

  if (config.plugins && typeof config.plugins === "object") {
    if (Array.isArray(config.plugins.allow)) {
      const nextAllow = config.plugins.allow.filter((item) => item !== pluginId);
      if (nextAllow.length !== config.plugins.allow.length) {
        if (nextAllow.length > 0) {
          config.plugins.allow = nextAllow;
        } else {
          delete config.plugins.allow;
        }
        changed = true;
      }
    }

    if (
      config.plugins.entries &&
      typeof config.plugins.entries === "object" &&
      Object.prototype.hasOwnProperty.call(config.plugins.entries, pluginId)
    ) {
      delete config.plugins.entries[pluginId];
      pruneEmptyObject(config.plugins, "entries");
      changed = true;
    }

    if (
      config.plugins.installs &&
      typeof config.plugins.installs === "object" &&
      Object.prototype.hasOwnProperty.call(config.plugins.installs, pluginId)
    ) {
      delete config.plugins.installs[pluginId];
      pruneEmptyObject(config.plugins, "installs");
      changed = true;
    }

    pruneEmptyObject(config, "plugins");
  }

  if (changed) {
    writeConfigFile(config, configPath);
  }

  return { changed, configPath };
}

function upsertXiaozhiChannelConfig(accountId, accountConfig, pluginId = "xiaozhi") {
  const configPath = resolveOpenClawConfigPath();
  const config = readConfigFile(configPath);
  const channels =
    config.channels && typeof config.channels === "object" ? config.channels : {};
  const currentSection =
    channels[pluginId] && typeof channels[pluginId] === "object"
      ? channels[pluginId]
      : {};
  const accounts =
    currentSection.accounts && typeof currentSection.accounts === "object"
      ? currentSection.accounts
      : {};

  accounts[accountId] = accountConfig;
  channels[pluginId] = {
    ...currentSection,
    defaultAccountId: accountId,
    accounts
  };
  config.channels = channels;
  writeConfigFile(config, configPath);
  return configPath;
}

function canResolvePluginSdk(pluginDir) {
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      "import('openclaw/plugin-sdk').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    ],
    {
      cwd: pluginDir,
      stdio: "ignore"
    }
  );
  return result.status === 0;
}

function ensurePluginHostLink(pluginId = "xiaozhi") {
  const pluginDir = resolvePluginDir(pluginId);
  if (!fs.existsSync(pluginDir)) {
    return false;
  }
  if (canResolvePluginSdk(pluginDir)) {
    return true;
  }

  const openclawDir = resolveOpenClawPackageDir();
  if (!openclawDir) {
    return false;
  }

  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const linkPath = path.join(nodeModulesDir, "openclaw");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  if (fs.existsSync(linkPath)) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(openclawDir, linkPath, "dir");
  return canResolvePluginSdk(pluginDir);
}

function healConfigBeforeInstall() {
  runOpenClawBestEffort(["doctor", "--fix"]);
}

function getPluginInfo(pluginId = "xiaozhi") {
  try {
    return runOpenClawJson(["plugins", "info", pluginId, "--json"]);
  } catch {
    return null;
  }
}

function assertPluginReady(pluginId = "xiaozhi") {
  const info = getPluginInfo(pluginId);
  if (info?.id === pluginId) {
    return info;
  }

  const doctorOutput = tryRunOpenClawCapture(["plugins", "doctor"]);
  const pluginDir = resolvePluginDir(pluginId);
  const hints = [];
  if (fs.existsSync(pluginDir)) {
    hints.push(`extensionDir=${pluginDir}`);
  }
  if (doctorOutput) {
    hints.push(`pluginsDoctor=${doctorOutput}`);
  }
  const details = hints.length > 0 ? `\n${hints.join("\n")}` : "";
  throw new Error(`插件 ${pluginId} 安装后未被 OpenClaw 正确识别。${details}`);
}

async function installCommand(options) {
  const rl = createInterface({ input, output });
  try {
    const accountId = options.account || DEFAULT_ACCOUNT_ID;
    assertSimpleAccountId(accountId);
    const serverUrl = await resolveValue(
      rl,
      options["server-url"] || "",
      "xiaozhi-server 地址"
    );
    const adminKey = await resolveValue(
      rl,
      options["admin-key"] || "",
      "admin key",
      "",
      { secret: true }
    );
    const defaultAgentId = await resolveValue(
      rl,
      options["default-agent-id"] || "",
      "默认 agentId"
    );
    const bridgeName = await resolveValue(
      rl,
      options.name || "",
      "bridge 名称",
      `xiaozhi-${accountId}`
    );
    const bridgeId = await resolveValue(
      rl,
      options["bridge-id"] || "",
      "bridgeId（留空自动生成）"
    );

    const pluginSpec = options["plugin-spec"] || DEFAULT_PLUGIN_SPEC;
    healConfigBeforeInstall();
    sanitizeXiaozhiConfig("xiaozhi");
    cleanupExistingPlugin("xiaozhi");
    runOpenClaw(["plugins", "install", pluginSpec, "--pin"]);
    const hostLinkReady = ensurePluginHostLink("xiaozhi");
    let pluginInfo = assertPluginReady("xiaozhi");
    if (pluginInfo?.enabled === false) {
      runOpenClaw(["plugins", "enable", "xiaozhi"]);
      pluginInfo = assertPluginReady("xiaozhi");
    }

    const issued = await issueBridgeToken({
      serverUrl,
      adminKey,
      accountId,
      defaultAgentId,
      name: bridgeName,
      bridgeId
    });

    const accountConfig = {
      enabled: true,
      bridgeId: issued.bridge.bridgeId,
      serverUrl: issued.bridgeWebSocketUrl,
      bridgeToken: issued.token,
      defaultAgentId: defaultAgentId || undefined,
      staticBindings: {}
    };

    const configPath = upsertXiaozhiChannelConfig(accountId, accountConfig, "xiaozhi");
    if (!options["no-restart"]) {
      runOpenClaw(["gateway", "restart"]);
    }

    console.log("");
    console.log("安装完成");
    console.log(`plugin id: xiaozhi`);
    console.log(`account: ${accountId}`);
    console.log(`bridgeId: ${issued.bridge.bridgeId}`);
    console.log(`server: ${issued.bridgeWebSocketUrl}`);
    console.log(`config: ${configPath}`);
    if (!hostLinkReady) {
      console.log("warning: 未能自动修复 openclaw/plugin-sdk 解析，请检查 OpenClaw 全局安装路径");
    }
  } finally {
    rl.close();
  }
}

async function statusCommand(options) {
  const accountId = options.account || DEFAULT_ACCOUNT_ID;
  assertSimpleAccountId(accountId);
  const bridgeId = tryRunOpenClawCapture([
    "config",
    "get",
    `channels.xiaozhi.accounts.${accountId}.bridgeId`
  ]);
  const serverUrl = tryRunOpenClawCapture([
    "config",
    "get",
    `channels.xiaozhi.accounts.${accountId}.serverUrl`
  ]);
  const defaultAgentId = tryRunOpenClawCapture([
    "config",
    "get",
    `channels.xiaozhi.accounts.${accountId}.defaultAgentId`
  ]);
  console.log(`account: ${accountId}`);
  console.log(`bridgeId: ${bridgeId}`);
  console.log(`serverUrl: ${serverUrl}`);
  console.log(`defaultAgentId: ${defaultAgentId || "(none)"}`);
}

async function unbindCommand(options) {
  const rl = createInterface({ input, output });
  try {
    const accountId = options.account || DEFAULT_ACCOUNT_ID;
    assertSimpleAccountId(accountId);
    const serverUrl =
      options["server-url"] ||
      tryRunOpenClawCapture([
        "config",
        "get",
        `channels.xiaozhi.accounts.${accountId}.serverUrl`
      ]);
    const bridgeId =
      options["bridge-id"] ||
      tryRunOpenClawCapture([
        "config",
        "get",
        `channels.xiaozhi.accounts.${accountId}.bridgeId`
      ]);
    const adminKey = await resolveValue(
      rl,
      options["admin-key"] || "",
      "admin key",
      "",
      { secret: true }
    );

    if (serverUrl && bridgeId && adminKey) {
      const response = await fetch(
        buildAdminUrl(serverUrl, "/admin/openclaw/revoke-bridge-token"),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ bridgeId })
        }
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || `撤销 bridge 失败: HTTP ${response.status}`);
      }
    }

    runOpenClaw([
      "config",
      "unset",
      `channels.xiaozhi.accounts.${accountId}`
    ]);
    if (!options["no-restart"]) {
      runOpenClaw(["gateway", "restart"]);
    }
    console.log(`已解绑 account=${accountId}`);
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log("Usage:");
  console.log("  openclaw-xiaozhi install");
  console.log("  openclaw-xiaozhi status [--account default]");
  console.log("  openclaw-xiaozhi unbind [--account default]");
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "install") {
    await installCommand(options);
    return;
  }
  if (command === "status") {
    await statusCommand(options);
    return;
  }
  if (command === "unbind") {
    await unbindCommand(options);
    return;
  }
  printHelp();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
