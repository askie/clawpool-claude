import process from "node:process";
import {
  maskApiKey,
  validateConfig,
} from "./config.js";
import { ConfigStore } from "../server/config-store.js";
import { resolveDaemonConfigPath, resolveDaemonDataDir } from "../server/daemon/daemon-paths.js";

function usage() {
  return `用法:
  clawpool-claude [options]
  clawpool-claude daemon [options]
  clawpool-claude worker [options]

说明:
  默认命令会写好 daemon 配置，并启动 clawpool-claude daemon。
  daemon 是唯一对接 ClawPool 的常驻服务，Claude 会话由 daemon 按需拉起。

  选项:
  --ws-url <value>      ClawPool Agent API WebSocket 地址
  --agent-id <value>    Agent ID
  --api-key <value>     API Key
  --data-dir <path>     daemon 数据目录，默认 ~/.claude/clawpool-claude-daemon
  --chunk-limit <n>     单段文本长度上限，默认 1200
  --show-claude         开发调试时把 Claude 拉到可见的 Terminal 窗口
  --no-launch           只检查并写好配置，不启动 daemon
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
    showClaude: false,
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
    if (current === "--show-claude") {
      options.showClaude = true;
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

function print(message) {
  process.stdout.write(`${message}\n`);
}

function printError(message) {
  process.stderr.write(`${message}\n`);
}

function buildRuntimeEnv(options, env) {
  return {
    ...env,
    ...(options.dataDir ? { CLAWPOOL_DAEMON_DATA_DIR: options.dataDir } : {}),
    ...(options.showClaude ? { CLAWPOOL_SHOW_CLAUDE_WINDOW: "1" } : {}),
  };
}

function buildDaemonStatus(configStore) {
  const config = configStore.get();
  validateConfig(config);
  return {
    config,
    configPath: configStore.filePath,
  };
}

async function prepareDaemonConfig(options, env = process.env) {
  const runtimeEnv = buildRuntimeEnv(options, env);
  const configStore = new ConfigStore(resolveDaemonConfigPath(runtimeEnv), {
    env: runtimeEnv,
  });
  await configStore.load();
  if (options.wsUrl || options.agentId || options.apiKey || options.chunkLimit) {
    await configStore.update({
      ...(options.wsUrl ? { ws_url: options.wsUrl } : {}),
      ...(options.agentId ? { agent_id: options.agentId } : {}),
      ...(options.apiKey ? { api_key: options.apiKey } : {}),
      ...(options.chunkLimit ? { outbound_text_chunk_limit: Number(options.chunkLimit) } : {}),
    });
  }
  return {
    runtimeEnv,
    dataDir: resolveDaemonDataDir(runtimeEnv),
    ...buildDaemonStatus(configStore),
  };
}

async function runDefault(argv, env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    print(usage());
    return 0;
  }

  const { runtimeEnv, dataDir, config, configPath } = await prepareDaemonConfig(options, env);

  print(`配置已准备好。`);
  print(`数据目录: ${dataDir}`);
  print(`配置文件: ${configPath}`);
  print(`Agent ID: ${config.agent_id}`);
  print(`API Key: ${maskApiKey(config.api_key)}`);

  if (options.noLaunch) {
    print(`daemon 还没有启动。需要时直接执行 clawpool-claude 即可。`);
    return 0;
  }

  print(`正在启动 daemon...`);
  const { run } = await import("../server/daemon/main.js");
  return run([], runtimeEnv);
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
  return runDefault(argv, env);
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
