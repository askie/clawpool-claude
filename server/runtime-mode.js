import { readFileSync } from "node:fs";
import path from "node:path";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function loadWorkspaceMCPConfig(cwd) {
  const workspace = normalizeString(cwd);
  if (!workspace) {
    return null;
  }
  try {
    const raw = readFileSync(path.join(workspace, ".mcp.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function resolveClawpoolRuntimeMode({ env = process.env, cwd = process.cwd() } = {}) {
  const inlinePluginRuntime = normalizeString(env.CLAUDE_PLUGIN_ROOT) !== "";
  const workspaceConfig = loadWorkspaceMCPConfig(cwd);
  const workspaceHasClawpoolServer = Boolean(workspaceConfig?.mcpServers?.["clawpool-claude"]);
  const passiveInlineRuntime = inlinePluginRuntime && workspaceHasClawpoolServer;

  return {
    inlinePluginRuntime,
    workspaceHasClawpoolServer,
    passiveInlineRuntime,
    transportEnabled: !passiveInlineRuntime,
    toolExposure: passiveInlineRuntime ? "none" : "full",
  };
}
