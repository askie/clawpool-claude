import { spawn } from "node:child_process";
import process from "node:process";
import {
  loadConfig,
  maskApiKey,
  resolveDataDir,
  resolvePackageRoot,
  resolveServerEntryPath,
  validateConfig,
  writeConfig,
} from "./config.js";
import { ensureUserMcpServer } from "./mcp.js";

function usage() {
  return `用法:
  clawpool-claude [options]
  clawpool-claude daemon [options]
  clawpool-claude worker [options]

说明:
  自动保存连接信息，安装 Claude 的用户级 clawpool-claude MCP，并直接打开 Claude。
  也支持 daemon 和 worker 管理子命令。

选项:
  --ws-url <value>      ClawPool Agent API WebSocket 地址
  --agent-id <value>    Agent ID
  --api-key <value>     API Key
  --data-dir <path>     配置和运行数据目录，默认 ~/.claude/clawpool-claude
  --chunk-limit <n>     单段文本长度上限，默认 1200
  --no-launch           只检查并写好配置，不打开 Claude
  --help, -h            显示帮助

第一次运行需要传完整参数。
后续再次运行时，如果本地已经保存过配置，可以直接执行: clawpool-claude
`;
}

function parseArgs(argv) {
  const options = {
    wsUrl: "",
    agentId: "",
    apiKey: "",
    dataDir: "",
    chunkLimit: "",
    noLaunch: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") {
      options.help = true;
      continue;
    }
    if (current === "--no-launch") {
      options.noLaunch = true;
      continue;
    }
    const next = argv[index + 1];
    if (current === "--ws-url") {
      if (!next) {
        throw new Error("--ws-url 缺少值。");
      }
      options.wsUrl = next;
      index += 1;
      continue;
    }
    if (current === "--agent-id") {
      if (!next) {
        throw new Error("--agent-id 缺少值。");
      }
      options.agentId = next;
      index += 1;
      continue;
    }
    if (current === "--api-key") {
      if (!next) {
        throw new Error("--api-key 缺少值。");
      }
      options.apiKey = next;
      index += 1;
      continue;
    }
    if (current === "--data-dir") {
      if (!next) {
        throw new Error("--data-dir 缺少值。");
      }
      options.dataDir = next;
      index += 1;
      continue;
    }
    if (current === "--chunk-limit") {
      if (!next) {
        throw new Error("--chunk-limit 缺少值。");
      }
      options.chunkLimit = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${current}`);
  }

  return options;
}

function resolveClaudeCommand(env = process.env) {
  if (process.platform === "win32") {
    return env.CLAUDE_BIN || "claude.cmd";
  }
  return env.CLAUDE_BIN || "claude";
}

function print(message) {
  process.stdout.write(`${message}\n`);
}

function printError(message) {
  process.stderr.write(`${message}\n`);
}

async function runLegacy(argv, env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    print(usage());
    return 0;
  }

  const dataDir = resolveDataDir({ dataDir: options.dataDir, env });
  const config = await loadConfig({
    dataDir,
    env,
    args: options,
  });
  validateConfig(config);

  const configPath = await writeConfig({ dataDir, config });
  const packageRoot = resolvePackageRoot();
  const serverEntryPath = resolveServerEntryPath();
  const claudeCommand = resolveClaudeCommand(env);

  await ensureUserMcpServer({
    claudeCommand,
    serverCommand: process.execPath,
    serverArgs: [serverEntryPath],
    env,
  });

  print(`配置已准备好。`);
  print(`数据目录: ${dataDir}`);
  print(`配置文件: ${configPath}`);
  print(`Agent ID: ${config.agent_id}`);
  print(`API Key: ${maskApiKey(config.api_key)}`);

  if (options.noLaunch) {
    print(`Claude 还没有打开。需要时直接执行 clawpool-claude 即可。`);
    return 0;
  }

  print(`正在打开 Claude...`);

  return await new Promise((resolve, reject) => {
    const child = spawn(
      claudeCommand,
      [
        "--plugin-dir",
        packageRoot,
        "--dangerously-load-development-channels",
        "server:clawpool-claude",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...env,
          CLAUDE_PLUGIN_DATA: dataDir,
        },
        stdio: "inherit",
      },
    );

    child.on("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        reject(new Error("没有找到 claude 命令，请先安装并登录 Claude Code。"));
        return;
      }
      reject(error);
    });

    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function runSubcommand(name, argv, env) {
  if (name === "daemon") {
    const { run } = await import("../server/daemon/main.js");
    return run(argv, env);
  }
  if (name === "worker") {
    const { run } = await import("../server/worker/main.js");
    return run(argv, env);
  }
  throw new Error(`未知子命令: ${name}`);
}

export async function run(argv, env = process.env) {
  const [first = ""] = argv;
  if (first === "daemon" || first === "worker") {
    return runSubcommand(first, argv.slice(1), env);
  }
  return runLegacy(argv, env);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const exitCode = await run(argv, env);
    process.exitCode = exitCode;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    printError("");
    printError(usage());
    process.exitCode = 1;
  }
}
