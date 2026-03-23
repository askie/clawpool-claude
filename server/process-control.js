import { spawn } from "node:child_process";
import process from "node:process";

function normalizePID(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

export function isProcessRunning(pid, { killImpl = process.kill } = {}) {
  const normalizedPID = normalizePID(pid);
  if (!normalizedPID) {
    return false;
  }
  try {
    killImpl(normalizedPID, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ESRCH") {
        return false;
      }
      if (error.code === "EPERM") {
        return true;
      }
    }
    return false;
  }
}

export async function runCommand(
  command,
  args = [],
  {
    spawnImpl = spawn,
    cwd = "",
    env = process.env,
    allowFailure = false,
  } = {},
) {
  const child = spawnImpl(command, args, {
    cwd: cwd || undefined,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  if (child.stdout) {
    for await (const chunk of child.stdout) {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  }
  if (child.stderr) {
    for await (const chunk of child.stderr) {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(Number(code ?? 0)));
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (exitCode !== 0 && !allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `${command} exited with code ${exitCode}`;
    throw new Error(detail);
  }
  return {
    exitCode,
    stdout,
    stderr,
  };
}

export async function terminateProcessTree(
  pid,
  {
    platform = process.platform,
    killImpl = process.kill,
    runCommandImpl = runCommand,
  } = {},
) {
  const normalizedPID = normalizePID(pid);
  if (!normalizedPID) {
    return false;
  }
  if (platform === "win32") {
    await runCommandImpl("taskkill", [
      "/PID",
      String(normalizedPID),
      "/T",
      "/F",
    ], {
      allowFailure: true,
    });
    return true;
  }
  try {
    killImpl(-normalizedPID, "SIGTERM");
    return true;
  } catch {
    // fall through to direct pid kill
  }
  try {
    killImpl(normalizedPID, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(
  pid,
  {
    timeoutMs = 5000,
    intervalMs = 100,
    isProcessRunningImpl = isProcessRunning,
  } = {},
) {
  const normalizedPID = normalizePID(pid);
  if (!normalizedPID) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessRunningImpl(normalizedPID)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !isProcessRunningImpl(normalizedPID);
}
