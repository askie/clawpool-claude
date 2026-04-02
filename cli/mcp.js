import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const serverName = "grix-claude";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function runClaudeCommand({ claudeCommand, args, cwd, env, allowFailure = false }) {
  const result = spawnSync(claudeCommand, args, {
    cwd,
    env,
    encoding: "utf8",
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("没有找到 claude 命令，请先安装并登录 Claude Code。");
    }
    throw result.error;
  }

  if (result.status !== 0 && !allowFailure) {
    const output = normalizeString(result.stderr || result.stdout);
    throw new Error(output || `Claude 命令执行失败: ${args.join(" ")}`);
  }

  return result;
}

function sameArgs(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function resolveClaudeConfigPath(env) {
  const homeDir = normalizeString(env.HOME || env.USERPROFILE) || os.homedir();
  return path.join(homeDir, ".claude.json");
}

async function readUserScopedServer(env) {
  try {
    const raw = await readFile(resolveClaudeConfigPath(env), "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers?.[serverName] ?? null;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function ensureUserMcpServer({
  claudeCommand,
  serverCommand,
  serverArgs,
  env = process.env,
}) {
  const tempCwd = await mkdtemp(path.join(os.tmpdir(), "grix-claude-mcp-"));

  try {
    const current = await readUserScopedServer(env);
    if (
      current &&
      normalizeString(current.type || "stdio") === "stdio" &&
      normalizeString(current.command) === serverCommand &&
      sameArgs(Array.isArray(current.args) ? current.args : [], serverArgs)
    ) {
      return;
    }

    runClaudeCommand({
      claudeCommand,
      args: ["mcp", "remove", "-s", "user", serverName],
      cwd: tempCwd,
      env,
      allowFailure: true,
    });

    runClaudeCommand({
      claudeCommand,
      args: ["mcp", "add", "--scope", "user", serverName, "--", serverCommand, ...serverArgs],
      cwd: tempCwd,
      env,
    });

    const verifiedDetails = await readUserScopedServer(env);
    if (
      !verifiedDetails ||
      normalizeString(verifiedDetails.type || "stdio") !== "stdio" ||
      normalizeString(verifiedDetails.command) !== serverCommand ||
      !sameArgs(Array.isArray(verifiedDetails.args) ? verifiedDetails.args : [], serverArgs)
    ) {
      throw new Error("用户级 Claude MCP 配置写入后校验失败。");
    }
  } finally {
    await rm(tempCwd, { recursive: true, force: true });
  }
}
