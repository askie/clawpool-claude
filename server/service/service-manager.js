import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdir } from "node:fs/promises";
import { resolvePackageBinPath } from "../../cli/config.js";
import { inspectDaemonProcessState } from "../daemon/process-state.js";
import { runCommand, terminateProcessTree, waitForProcessExit } from "../process-control.js";
import {
  buildServiceID,
  resolveServiceInstallRecordPath,
  resolveServiceLogsDir,
  resolveServiceStderrPath,
  resolveServiceStdoutPath,
} from "./service-paths.js";
import { ServiceInstallStore } from "./service-install-store.js";
import { getPlatformServiceAdapter } from "./platform-adapter.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeDataDir(input) {
  return path.resolve(normalizeString(input));
}

export class ServiceManager {
  constructor({
    env = process.env,
    platform = process.platform,
    homeDir = os.homedir(),
    uid = process.getuid?.() ?? 0,
    nodePath = process.execPath,
    cliPath = resolvePackageBinPath(),
    now = () => Date.now(),
    runCommandImpl = runCommand,
  } = {}) {
    this.env = env;
    this.platform = platform;
    this.homeDir = homeDir;
    this.uid = uid;
    this.nodePath = nodePath;
    this.cliPath = cliPath;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.runCommandImpl = runCommandImpl;
    this.adapter = getPlatformServiceAdapter(platform);
  }

  buildDescriptor(dataDir, definitionPath = "") {
    const normalizedDataDir = normalizeDataDir(dataDir);
    return {
      platform: this.platform,
      service_id: buildServiceID(normalizedDataDir, this.platform),
      node_path: normalizeString(this.nodePath),
      cli_path: normalizeString(this.cliPath),
      definition_path: normalizeString(definitionPath),
      data_dir: normalizedDataDir,
    };
  }

  createStore(dataDir) {
    return new ServiceInstallStore(resolveServiceInstallRecordPath(normalizeDataDir(dataDir)));
  }

  toAdapterPayload(descriptor) {
    return {
      serviceID: descriptor.service_id,
      nodePath: descriptor.node_path,
      cliPath: descriptor.cli_path,
      definitionPath: descriptor.definition_path,
      dataDir: descriptor.data_dir,
      environmentPath: normalizeString(this.env.PATH),
    };
  }

  async loadDescriptor(dataDir) {
    const store = this.createStore(dataDir);
    const stored = await store.load();
    if (!stored) {
      throw new Error("后台服务还没有安装，请先执行 install。");
    }
    return {
      store,
      descriptor: stored,
    };
  }

  isDescriptorCurrent(descriptor) {
    return (
      normalizeString(descriptor?.node_path) === normalizeString(this.nodePath) &&
      normalizeString(descriptor?.cli_path) === normalizeString(this.cliPath)
    );
  }

  async refreshDescriptor(dataDir, descriptor) {
    const normalizedDataDir = normalizeDataDir(dataDir);
    const logsDir = resolveServiceLogsDir(normalizedDataDir);
    await mkdir(logsDir, { recursive: true, mode: 0o700 });

    const nextDescriptor = {
      ...descriptor,
      platform: this.platform,
      service_id: normalizeString(descriptor?.service_id) || buildServiceID(normalizedDataDir, this.platform),
      node_path: normalizeString(this.nodePath),
      cli_path: normalizeString(this.cliPath),
      definition_path: normalizeString(descriptor?.definition_path),
      data_dir: normalizedDataDir,
    };
    const installResult = await this.adapter.install({
      ...this.toAdapterPayload(nextDescriptor),
      stdoutPath: resolveServiceStdoutPath(normalizedDataDir),
      stderrPath: resolveServiceStderrPath(normalizedDataDir),
      homeDir: this.homeDir,
      uid: this.uid,
      runCommand: this.runCommandImpl,
    });
    const refreshed = {
      ...nextDescriptor,
      installed_at: Number(descriptor?.installed_at ?? 0),
      definition_path: normalizeString(installResult?.definitionPath || nextDescriptor.definition_path),
      updated_at: this.now(),
    };
    await this.createStore(normalizedDataDir).save(refreshed);
    return refreshed;
  }

  async resolveActiveDescriptor(dataDir) {
    const normalizedDataDir = normalizeDataDir(dataDir);
    const { descriptor } = await this.loadDescriptor(normalizedDataDir);
    if (this.isDescriptorCurrent(descriptor)) {
      return descriptor;
    }
    return this.refreshDescriptor(normalizedDataDir, descriptor);
  }

  async install({ dataDir }) {
    const normalizedDataDir = normalizeDataDir(dataDir);
    const logsDir = resolveServiceLogsDir(normalizedDataDir);
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    const created = this.buildDescriptor(normalizedDataDir);
    const installResult = await this.adapter.install({
      ...this.toAdapterPayload(created),
      stdoutPath: resolveServiceStdoutPath(normalizedDataDir),
      stderrPath: resolveServiceStderrPath(normalizedDataDir),
      homeDir: this.homeDir,
      uid: this.uid,
      runCommand: this.runCommandImpl,
    });
    const descriptor = {
      ...created,
      definition_path: normalizeString(installResult?.definitionPath),
      installed_at: this.now(),
      updated_at: this.now(),
    };
    await this.createStore(normalizedDataDir).save(descriptor);
    await this.adapter.start({
      ...this.toAdapterPayload(descriptor),
      homeDir: this.homeDir,
      uid: this.uid,
      runCommand: this.runCommandImpl,
    });
    await this.waitForDaemonStarted(normalizedDataDir);
    return this.status({ dataDir: normalizedDataDir });
  }

  async waitForDaemonStarted(
    dataDir,
    {
      oldPid = 0,
      minUpdatedAt = 0,
      timeoutMs = 5000,
    } = {},
  ) {
    const { setTimeout: sleep } = await import("node:timers/promises");
    const start = this.now();
    let lastState = null;
    while (this.now() - start < timeoutMs) {
      const state = await inspectDaemonProcessState({ dataDir });
      lastState = state;
      const restarted = oldPid <= 0
        || state.pid !== oldPid
        || Number(state.updated_at ?? 0) > Number(minUpdatedAt ?? 0);
      if (state.running && state.pid && restarted) {
        return state;
      }
      await sleep(100);
    }
    throw new Error(
      `daemon start timeout (${timeoutMs}ms), state=${lastState?.state || "unknown"}, pid=${Number(lastState?.pid ?? 0)}`,
    );
  }

  async start({ dataDir }) {
    const descriptor = await this.resolveActiveDescriptor(dataDir);
    const state = await inspectDaemonProcessState({
      dataDir: descriptor.data_dir,
    });
    if (state.running) {
      return this.status({ dataDir: descriptor.data_dir });
    }
    await this.adapter.start({
      ...this.toAdapterPayload(descriptor),
      homeDir: this.homeDir,
      uid: this.uid,
      runCommand: this.runCommandImpl,
    });
    await this.waitForDaemonStarted(descriptor.data_dir, {
      oldPid: state.pid,
      minUpdatedAt: state.updated_at,
    });
    return this.status({ dataDir: descriptor.data_dir });
  }

  async stop({ dataDir }) {
    const { descriptor } = await this.loadDescriptor(dataDir);
    const before = await inspectDaemonProcessState({
      dataDir: descriptor.data_dir,
    });
    await this.adapter.stop({
      ...this.toAdapterPayload(descriptor),
      homeDir: this.homeDir,
      uid: this.uid,
      runCommand: this.runCommandImpl,
    });
    if (before.running && before.pid) {
      const exited = await waitForProcessExit(before.pid, {
        timeoutMs: 5000,
      });
      if (!exited) {
        await terminateProcessTree(before.pid, {
          platform: this.platform,
          runCommandImpl: this.runCommandImpl,
        });
        await waitForProcessExit(before.pid, {
          timeoutMs: 5000,
        });
      }
    }
    return this.status({ dataDir: descriptor.data_dir });
  }

  async restart({ dataDir }) {
    const descriptor = await this.resolveActiveDescriptor(dataDir);
    const before = await inspectDaemonProcessState({
      dataDir: descriptor.data_dir,
    });
    await this.adapter.restart({
      ...this.toAdapterPayload(descriptor),
      homeDir: this.homeDir,
      uid: this.uid,
      runCommand: this.runCommandImpl,
    });
    await this.waitForDaemonStarted(descriptor.data_dir, {
      oldPid: before.pid,
      minUpdatedAt: before.updated_at,
    });
    return this.status({ dataDir: descriptor.data_dir });
  }

  async uninstall({ dataDir }) {
    const normalizedDataDir = normalizeDataDir(dataDir);
    const store = this.createStore(normalizedDataDir);
    const descriptor = await store.load();
    if (!descriptor) {
      return {
        installed: false,
        install_state: "missing",
        data_dir: normalizedDataDir,
        service_kind: this.adapter.kind,
        daemon_state: "stopped",
      };
    }
    await this.adapter.uninstall({
      ...this.toAdapterPayload(descriptor),
      homeDir: this.homeDir,
      uid: this.uid,
      runCommand: this.runCommandImpl,
    });
    await store.clear();
    return this.status({ dataDir: normalizedDataDir });
  }

  async status({ dataDir }) {
    const normalizedDataDir = normalizeDataDir(dataDir);
    const store = this.createStore(normalizedDataDir);
    const descriptor = await store.load();
    const daemonState = await inspectDaemonProcessState({
      dataDir: normalizedDataDir,
    });
    if (!descriptor) {
      return {
        installed: false,
        install_state: "missing",
        service_kind: this.adapter.kind,
        data_dir: normalizedDataDir,
        daemon_state: daemonState.running ? "running" : daemonState.state,
        pid: daemonState.pid,
      };
    }
    const installState = this.isDescriptorCurrent(descriptor) ? "current" : "stale";
    return {
      installed: true,
      install_state: installState,
      service_kind: this.adapter.kind,
      service_id: descriptor.service_id,
      definition_path: descriptor.definition_path,
      data_dir: descriptor.data_dir,
      daemon_state: daemonState.running ? "running" : daemonState.state,
      pid: daemonState.pid,
      bridge_url: daemonState.bridge_url,
      configured: daemonState.configured,
      connection_state: daemonState.connection_state,
      updated_at: daemonState.updated_at,
    };
  }
}
