import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { main, run } from "./main.js";

test("cli main prints the running command and redacts api key", async () => {
  const outputs = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    await main([
      "--help",
      "--api-key",
      "secret-value",
      "--data-dir",
      "/tmp/demo dir",
    ], {});
    const content = outputs.join("");
    assert.match(content, /运行命令:\s+clawpool-claude --help --api-key '\*\*\*\*\*\*' --data-dir '\/tmp\/demo dir'/u);
    assert.doesNotMatch(content, /secret-value/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("cli run routes daemon subcommand", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-route-cli-"));
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "daemon",
      "--exit-after-ready",
      "--data-dir",
      tempDir,
    ], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /daemon 已启动/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("cli run routes worker subcommand", async () => {
  const outputs = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run(["worker"], {});
    assert.equal(exitCode, 1);
    assert.match(outputs.join(""), /不要手动运行 worker/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("default cli path persists daemon config without starting daemon when --no-launch is used", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-default-cli-"));
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "--no-launch",
      "--data-dir",
      tempDir,
      "--ws-url",
      "ws://127.0.0.1:8888/ws",
      "--agent-id",
      "agent-default",
      "--api-key",
      "key-default",
    ], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /daemon 还没有启动/u);

    const config = JSON.parse(
      await readFile(path.join(tempDir, "daemon-config.json"), "utf8"),
    );
    assert.equal(config.ws_url, "ws://127.0.0.1:8888/ws");
    assert.equal(config.agent_id, "agent-default");
    assert.equal(config.api_key, "key-default");
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("default cli path does not leak host process env into daemon config writes", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-env-cli-"));
  const originalStdoutWrite = process.stdout.write;
  const originalAgentID = process.env.CLAWPOOL_CLAUDE_AGENT_ID;
  const originalAPIKey = process.env.CLAWPOOL_CLAUDE_API_KEY;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };
  process.env.CLAWPOOL_CLAUDE_AGENT_ID = "stale-agent";
  process.env.CLAWPOOL_CLAUDE_API_KEY = "stale-key";

  try {
    const exitCode = await run([
      "--no-launch",
      "--data-dir",
      tempDir,
      "--ws-url",
      "ws://127.0.0.1:8899/ws",
      "--agent-id",
      "fresh-agent",
      "--api-key",
      "fresh-key",
    ], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /fresh-agent/u);

    const config = JSON.parse(
      await readFile(path.join(tempDir, "daemon-config.json"), "utf8"),
    );
    assert.equal(config.agent_id, "fresh-agent");
    assert.equal(config.api_key, "fresh-key");
  } finally {
    process.stdout.write = originalStdoutWrite;
    if (originalAgentID === undefined) {
      delete process.env.CLAWPOOL_CLAUDE_AGENT_ID;
    } else {
      process.env.CLAWPOOL_CLAUDE_AGENT_ID = originalAgentID;
    }
    if (originalAPIKey === undefined) {
      delete process.env.CLAWPOOL_CLAUDE_API_KEY;
    } else {
      process.env.CLAWPOOL_CLAUDE_API_KEY = originalAPIKey;
    }
  }
});

test("default cli path can enable visible Claude debug mode", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-show-claude-cli-"));
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "--no-launch",
      "--show-claude",
      "--data-dir",
      tempDir,
      "--ws-url",
      "ws://127.0.0.1:8890/ws",
      "--agent-id",
      "agent-show",
      "--api-key",
      "key-show",
    ], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /daemon 还没有启动/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("default cli path accepts CLAWPOOL_CLAUDE_ENDPOINT env for daemon config", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-endpoint-env-cli-"));
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "--no-launch",
      "--data-dir",
      tempDir,
    ], {
      CLAWPOOL_CLAUDE_ENDPOINT: "ws://127.0.0.1:27189/v1/agent-api/ws?agent_id=2035251418226495488",
      CLAWPOOL_CLAUDE_AGENT_ID: "2035251418226495488",
      CLAWPOOL_CLAUDE_API_KEY: "ak_2035251418226495488_Gyav9cyaOHbAUP7qrOJ4JHv13FR0XgwB",
    });
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /Agent ID: 2035251418226495488/u);
    assert.match(outputs.join(""), /daemon 还没有启动/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("cli daemon subcommand persists daemon config when options are provided", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-cli-"));
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "daemon",
      "--exit-after-ready",
      "--data-dir",
      tempDir,
      "--ws-url",
      "ws://127.0.0.1:7777/ws",
      "--agent-id",
      "agent-1",
      "--api-key",
      "key-1",
      "--chunk-limit",
      "2048",
    ], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /已配置: yes/u);

    const config = JSON.parse(
      await readFile(path.join(tempDir, "daemon-config.json"), "utf8"),
    );
    assert.equal(config.ws_url, "ws://127.0.0.1:7777/ws");
    assert.equal(config.agent_id, "agent-1");
    assert.equal(config.api_key, "key-1");
    assert.equal(config.outbound_text_chunk_limit, 2048);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("cli install subcommand prepares config and delegates to service manager", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-install-cli-"));
  const originalStdoutWrite = process.stdout.write;
  const calls = [];
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "install",
      "--data-dir",
      tempDir,
      "--ws-url",
      "ws://127.0.0.1:9010/ws",
      "--agent-id",
      "agent-install",
      "--api-key",
      "key-install",
    ], {}, {
      serviceManager: {
        install: async ({ dataDir }) => {
          calls.push({ kind: "install", dataDir });
          return {
            installed: true,
            service_kind: "systemd-user",
            data_dir: dataDir,
            install_state: "current",
            daemon_state: "running",
            service_id: "service-1",
          };
        },
      },
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [{
      kind: "install",
      dataDir: tempDir,
    }]);
    assert.match(outputs.join(""), /服务已安装: yes/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("cli status subcommand prints service manager status", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-status-cli-"));
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "status",
      "--data-dir",
      tempDir,
    ], {}, {
      serviceManager: {
        status: async ({ dataDir }) => ({
          installed: true,
          service_kind: "launchd",
          data_dir: dataDir,
          install_state: "current",
          daemon_state: "running",
          pid: 1234,
        }),
      },
    });
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /进程 PID: 1234/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});
