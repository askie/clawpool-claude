import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { ServiceManager } from "./service/service-manager.js";
import { ServiceInstallStore } from "./service/service-install-store.js";
import { resolveServiceInstallRecordPath } from "./service/service-paths.js";
import { DaemonProcessState, inspectDaemonProcessState } from "./daemon/process-state.js";

test("service manager installs linux user service with absolute paths", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-linux-"));
  const dataDir = path.join(tempRoot, "data");
  const calls = [];
  const manager = new ServiceManager({
    platform: "linux",
    homeDir: tempRoot,
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/grix/bin/grix-claude.js",
    runCommandImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  manager.waitForDaemonStarted = async () => {};

  const status = await manager.install({ dataDir });
  const unitPath = status.definition_path;
  const unitContent = await readFile(unitPath, "utf8");

  assert.equal(status.installed, true);
  assert.equal(status.service_kind, "systemd-user");
  assert.match(unitContent, /ExecStart='\/usr\/local\/bin\/node' '\/opt\/grix\/bin\/grix-claude\.js' 'daemon' '--data-dir'/u);
  assert.deepEqual(calls.map((entry) => `${entry.command} ${entry.args.join(" ")}`), [
    `systemctl --user daemon-reload`,
    `systemctl --user enable ${status.service_id}.service`,
    `systemctl --user start ${status.service_id}.service`,
  ]);
});

test("service manager install uses launchd bootstrap on macOS", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-macos-"));
  const dataDir = path.join(tempRoot, "data");
  const calls = [];
  const manager = new ServiceManager({
    platform: "darwin",
    homeDir: tempRoot,
    uid: 501,
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/grix/bin/grix-claude.js",
    runCommandImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  manager.waitForDaemonStarted = async () => {};

  const status = await manager.install({ dataDir });
  const plist = await readFile(status.definition_path, "utf8");

  assert.equal(status.installed, true);
  assert.equal(status.service_kind, "launchd");
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/u);
  assert.match(plist, /<key>EnvironmentVariables<\/key>/u);
  assert.match(plist, /<key>PATH<\/key>/u);
  assert.match(plist, /\/usr\/bin/u);
  assert.deepEqual(calls.map((entry) => `${entry.command} ${entry.args.join(" ")}`), [
    `launchctl bootstrap gui/501 ${status.definition_path}`,
    `launchctl kickstart -k gui/501/${status.service_id}`,
  ]);
});

test("service manager install uses task scheduler on windows", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-win-"));
  const dataDir = path.join(tempRoot, "data");
  const calls = [];
  const manager = new ServiceManager({
    platform: "win32",
    homeDir: tempRoot,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\grix\\bin\\grix-claude.js",
    runCommandImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  manager.waitForDaemonStarted = async () => {};

  const status = await manager.install({ dataDir });

  assert.equal(status.installed, true);
  assert.equal(status.service_kind, "task-scheduler");
  assert.deepEqual(calls.map((entry) => `${entry.command} ${entry.args.join(" ")}`), [
    `schtasks /Create /TN ${status.service_id} /SC ONLOGON /RL LIMITED /F /TR "C:\\Program Files\\nodejs\\node.exe" C:\\grix\\bin\\grix-claude.js daemon --data-dir ${path.resolve(dataDir)}`,
    `schtasks /Run /TN ${status.service_id}`,
  ]);
});

test("service manager status reports stale install when launcher path changed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-status-"));
  const dataDir = path.join(tempRoot, "data");
  const store = new ServiceInstallStore(resolveServiceInstallRecordPath(dataDir));
  await store.save({
    platform: "linux",
    service_id: "com.example.grix",
    node_path: "/old/node",
    cli_path: "/old/bin/grix-claude.js",
    definition_path: "/tmp/grix.service",
    data_dir: path.resolve(dataDir),
    installed_at: 1,
    updated_at: 1,
  });
  const manager = new ServiceManager({
    platform: "linux",
    homeDir: tempRoot,
    nodePath: "/new/node",
    cliPath: "/new/bin/grix-claude.js",
    runCommandImpl: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });

  const status = await manager.status({ dataDir });
  assert.equal(status.install_state, "stale");
  assert.equal(status.installed, true);
});

test("service manager waitForDaemonStarted throws on timeout", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-wait-timeout-"));
  const dataDir = path.join(tempRoot, "data");
  const manager = new ServiceManager({
    platform: "linux",
    homeDir: tempRoot,
    runCommandImpl: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });

  await assert.rejects(
    manager.waitForDaemonStarted(dataDir, { timeoutMs: 0 }),
    /daemon start timeout/u,
  );
});

test("service manager restart refreshes stale install descriptor before restart", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-restart-stale-"));
  const dataDir = path.join(tempRoot, "data");
  const store = new ServiceInstallStore(resolveServiceInstallRecordPath(dataDir));
  await store.save({
    platform: "darwin",
    service_id: "com.example.grix",
    node_path: "/old/node",
    cli_path: "/old/bin/grix-claude.js",
    definition_path: path.join(tempRoot, "Library", "LaunchAgents", "com.example.grix.plist"),
    data_dir: path.resolve(dataDir),
    installed_at: 1,
    updated_at: 1,
  });

  const calls = [];
  const manager = new ServiceManager({
    platform: "darwin",
    homeDir: tempRoot,
    uid: 501,
    nodePath: "/new/node",
    cliPath: "/new/bin/grix-claude.js",
    now: () => 99,
    runCommandImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  manager.waitForDaemonStarted = async () => {};

  const status = await manager.restart({ dataDir });
  const refreshed = await store.load();

  assert.equal(status.install_state, "current");
  assert.equal(refreshed?.node_path, "/new/node");
  assert.equal(refreshed?.cli_path, "/new/bin/grix-claude.js");
  assert.equal(refreshed?.updated_at, 99);
  const commands = calls.map((entry) => `${entry.command} ${entry.args.join(" ")}`);
  assert.equal(commands[0], `launchctl bootout gui/501/com.example.grix`);
  assert.equal(
    commands.some((entry) => entry === `launchctl print gui/501/com.example.grix`),
    true,
  );
  assert.equal(commands.at(-2), `launchctl bootstrap gui/501 ${refreshed.definition_path}`);
  assert.equal(commands.at(-1), `launchctl kickstart -k gui/501/com.example.grix`);
});

test("service manager start refreshes stale install descriptor before starting a stopped daemon", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-start-stale-"));
  const dataDir = path.join(tempRoot, "data");
  const store = new ServiceInstallStore(resolveServiceInstallRecordPath(dataDir));
  await store.save({
    platform: "darwin",
    service_id: "com.example.grix",
    node_path: "/old/node",
    cli_path: "/old/bin/grix-claude.js",
    definition_path: path.join(tempRoot, "Library", "LaunchAgents", "com.example.grix.plist"),
    data_dir: path.resolve(dataDir),
    installed_at: 1,
    updated_at: 1,
  });

  const calls = [];
  const manager = new ServiceManager({
    platform: "darwin",
    homeDir: tempRoot,
    uid: 501,
    nodePath: "/new/node",
    cliPath: "/new/bin/grix-claude.js",
    now: () => 123,
    runCommandImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  manager.waitForDaemonStarted = async () => {};

  const status = await manager.start({ dataDir });
  const refreshed = await store.load();

  assert.equal(status.install_state, "current");
  assert.equal(refreshed?.node_path, "/new/node");
  assert.equal(refreshed?.cli_path, "/new/bin/grix-claude.js");
  assert.equal(refreshed?.updated_at, 123);
  assert.deepEqual(calls.map((entry) => `${entry.command} ${entry.args.join(" ")}`), [
    `launchctl bootstrap gui/501 ${refreshed.definition_path}`,
    `launchctl kickstart -k gui/501/com.example.grix`,
  ]);
});

test("service manager start surfaces launchd kickstart failures", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-service-start-fail-"));
  const dataDir = path.join(tempRoot, "data");
  const store = new ServiceInstallStore(resolveServiceInstallRecordPath(dataDir));
  await store.save({
    platform: "darwin",
    service_id: "com.example.grix",
    node_path: "/new/node",
    cli_path: "/new/bin/grix-claude.js",
    definition_path: path.join(tempRoot, "Library", "LaunchAgents", "com.example.grix.plist"),
    data_dir: path.resolve(dataDir),
    installed_at: 1,
    updated_at: 1,
  });

  const calls = [];
  const manager = new ServiceManager({
    platform: "darwin",
    homeDir: tempRoot,
    uid: 501,
    nodePath: "/new/node",
    cliPath: "/new/bin/grix-claude.js",
    runCommandImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (args[0] === "kickstart") {
        return { exitCode: 1, stdout: "", stderr: "Operation not permitted" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    manager.start({ dataDir }),
    /launchctl start failed/u,
  );
  assert.deepEqual(calls.map((entry) => `${entry.command} ${entry.args.join(" ")}`), [
    `launchctl bootstrap gui/501 ${path.join(tempRoot, "Library", "LaunchAgents", "com.example.grix.plist")}`,
    `launchctl kickstart -k gui/501/com.example.grix`,
  ]);
});

test("daemon process state acquires lock and clears on release", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-daemon-state-"));
  const dataDir = path.join(tempRoot, "data");
  const state = new DaemonProcessState({
    dataDir,
    pid: process.pid,
    now: (() => {
      let current = 1000;
      return () => {
        current += 1;
        return current;
      };
    })(),
  });

  await state.acquire();
  await state.markRunning({
    bridgeURL: "http://127.0.0.1:8000",
    configured: true,
    connectionState: "connected",
  });

  let inspection = await inspectDaemonProcessState({ dataDir });
  assert.equal(inspection.running, true);
  assert.equal(inspection.bridge_url, "http://127.0.0.1:8000");
  const runningStatus = JSON.parse(
    await readFile(path.join(dataDir, "daemon-status.json"), "utf8"),
  );
  assert.equal(runningStatus.stopped_at, 0);
  assert.equal(runningStatus.exit_code, 0);

  await state.release({ exitCode: 0, reason: "shutdown" });
  inspection = await inspectDaemonProcessState({ dataDir });
  assert.equal(inspection.running, false);
  assert.equal(inspection.state, "stopped");
});

test("daemon process state replaces stale lock file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grix-daemon-stale-"));
  const dataDir = path.join(tempRoot, "data");
  const store = new ServiceInstallStore(resolveServiceInstallRecordPath(dataDir));
  await store.clear();

  const staleLockState = new DaemonProcessState({
    dataDir,
    pid: 999999,
    isProcessRunningImpl: () => false,
  });
  await staleLockState.acquire();
  await staleLockState.release();

  const fresh = new DaemonProcessState({
    dataDir,
    pid: process.pid,
  });
  await fresh.acquire();
  const inspection = await inspectDaemonProcessState({ dataDir });
  assert.equal(inspection.pid, process.pid);
  await fresh.release();
});
