import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClawpoolRuntimeMode } from "./runtime-mode.js";

test("runtime mode keeps transport enabled for standalone workspace server", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "clawpool-claude-runtime-standalone-"));
  writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "clawpool-claude": {
        command: "node",
        args: ["dist/main.cjs"],
      },
    },
  }));

  assert.deepEqual(
    resolveClawpoolRuntimeMode({
      cwd,
      env: {},
    }),
    {
      inlinePluginRuntime: false,
      workspaceHasClawpoolServer: true,
      passiveInlineRuntime: false,
      transportEnabled: true,
      toolExposure: "full",
    },
  );
});

test("runtime mode disables duplicate transport for inline companion with workspace clawpool-claude server", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "clawpool-claude-runtime-inline-"));
  writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "clawpool-claude": {
        command: "node",
        args: ["dist/main.cjs"],
      },
    },
  }));

  assert.deepEqual(
    resolveClawpoolRuntimeMode({
      cwd,
      env: {
        CLAUDE_PLUGIN_ROOT: "/abs/plugin/root",
      },
    }),
    {
      inlinePluginRuntime: true,
      workspaceHasClawpoolServer: true,
      passiveInlineRuntime: true,
      transportEnabled: false,
      toolExposure: "none",
    },
  );
});

test("runtime mode preserves transport for inline plugin without workspace clawpool-claude server", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "clawpool-claude-runtime-inline-solo-"));

  assert.deepEqual(
    resolveClawpoolRuntimeMode({
      cwd,
      env: {
        CLAUDE_PLUGIN_ROOT: "/abs/plugin/root",
      },
    }),
    {
      inlinePluginRuntime: true,
      workspaceHasClawpoolServer: false,
      passiveInlineRuntime: false,
      transportEnabled: true,
      toolExposure: "full",
    },
  );
});
