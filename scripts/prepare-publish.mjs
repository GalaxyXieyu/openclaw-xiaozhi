import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function normalizeScope(input) {
  const value = String(input || "").trim();
  if (!value) {
    throw new Error("缺少 --scope，例如 @galaxyxieyu");
  }
  if (!value.startsWith("@")) {
    return `@${value}`;
  }
  return value;
}

function buildRepoFields(repoUrl) {
  if (!repoUrl) {
    return {
      repository: {
        type: "git",
        url: "https://github.com/your-name/openclaw-xiaozhi.git"
      },
      homepage: "https://github.com/your-name/openclaw-xiaozhi#readme",
      bugs: {
        url: "https://github.com/your-name/openclaw-xiaozhi/issues"
      }
    };
  }

  const trimmed = repoUrl.replace(/\/+$/, "");
  const gitUrl = trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
  return {
    repository: {
      type: "git",
      url: gitUrl
    },
    homepage: `${trimmed.replace(/\.git$/, "")}#readme`,
    bugs: {
      url: `${trimmed.replace(/\.git$/, "")}/issues`
    }
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, data) {
  await fs.writeFile(`${filePath}`, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = normalizeScope(args.scope);
  const repoFields = buildRepoFields(args.repo);
  const pluginPackageName = `${scope}/openclaw-xiaozhi`;
  const cliPackageName = `${scope}/openclaw-xiaozhi-cli`;

  const pluginPackagePath = path.join(
    rootDir,
    "packages",
    "openclaw-xiaozhi",
    "package.json"
  );
  const cliPackagePath = path.join(
    rootDir,
    "packages",
    "openclaw-xiaozhi-cli",
    "package.json"
  );

  const pluginPackage = await readJson(pluginPackagePath);
  pluginPackage.name = pluginPackageName;
  pluginPackage.license = "MIT";
  pluginPackage.publishConfig = {
    access: "public"
  };
  pluginPackage.repository = repoFields.repository;
  pluginPackage.homepage = repoFields.homepage;
  pluginPackage.bugs = repoFields.bugs;
  pluginPackage.keywords = ["openclaw", "xiaozhi", "plugin", "channel", "agent"];

  const cliPackage = await readJson(cliPackagePath);
  cliPackage.name = cliPackageName;
  cliPackage.license = "MIT";
  cliPackage.publishConfig = {
    access: "public"
  };
  cliPackage.repository = repoFields.repository;
  cliPackage.homepage = repoFields.homepage;
  cliPackage.bugs = repoFields.bugs;
  cliPackage.keywords = ["openclaw", "xiaozhi", "cli", "installer"];
  cliPackage.openclawXiaozhi = {
    pluginPackage: pluginPackageName
  };

  await writeJson(pluginPackagePath, pluginPackage);
  await writeJson(cliPackagePath, cliPackage);

  process.stdout.write(
    [
      "Updated publish metadata:",
      `- plugin: ${pluginPackageName}`,
      `- cli: ${cliPackageName}`,
      `- repo: ${repoFields.homepage.replace(/#readme$/, "")}`
    ].join("\n") + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
