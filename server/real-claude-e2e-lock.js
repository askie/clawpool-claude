import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const realClaudeE2ELockDir = path.join(os.tmpdir(), "grix-real-claude-e2e.lock");
const ownerFileName = "owner.json";
const defaultWaitTimeoutMs = 5 * 60 * 1000;
const defaultPollMs = 250;
const defaultStaleMs = 10 * 60 * 1000;

function isErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function normalizePositiveInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackValue;
  }
  return Math.floor(numeric);
}

async function isLockStale(lockDir, staleMs) {
  try {
    const info = await stat(lockDir);
    return Date.now() - Number(info?.mtimeMs ?? 0) > staleMs;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function releaseLockIfOwned(lockDir, owner) {
  const ownerPath = path.join(lockDir, ownerFileName);
  let current = null;
  try {
    current = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  if (current?.token !== owner.token) {
    return;
  }
  await rm(lockDir, {
    recursive: true,
    force: true,
  });
}

export async function withRealClaudeE2ELock(run, {
  waitTimeoutMs = defaultWaitTimeoutMs,
  pollMs = defaultPollMs,
  staleMs = defaultStaleMs,
} = {}) {
  const lockDir = realClaudeE2ELockDir;
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    acquired_at: Date.now(),
  };
  const normalizedWaitTimeoutMs = normalizePositiveInt(waitTimeoutMs, defaultWaitTimeoutMs);
  const normalizedPollMs = normalizePositiveInt(pollMs, defaultPollMs);
  const normalizedStaleMs = normalizePositiveInt(staleMs, defaultStaleMs);
  const deadlineAt = Date.now() + normalizedWaitTimeoutMs;

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, ownerFileName),
        `${JSON.stringify(owner, null, 2)}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (await isLockStale(lockDir, normalizedStaleMs)) {
        await rm(lockDir, {
          recursive: true,
          force: true,
        });
        continue;
      }
      if (Date.now() >= deadlineAt) {
        throw new Error(`timed out waiting for real Claude e2e lock: ${lockDir}`);
      }
      await sleep(normalizedPollMs);
    }
  }

  try {
    return await run();
  } finally {
    await releaseLockIfOwned(lockDir, owner).catch(() => {});
  }
}
