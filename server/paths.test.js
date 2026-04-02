import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolvePluginDataDir } from "./paths.js";

test("resolvePluginDataDir prefers CLAUDE_PLUGIN_DATA without creating project files", () => {
  const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = "/tmp/grix-explicit-data";

  try {
    assert.equal(resolvePluginDataDir(), "/tmp/grix-explicit-data");
  } finally {
    if (originalDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
    }
  }
});

test("resolvePluginDataDir falls back to a stable home directory path", () => {
  const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    assert.equal(
      resolvePluginDataDir(),
      path.join(os.homedir(), ".claude", "grix-claude"),
    );
  } finally {
    if (originalDataDir !== undefined) {
      process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
    }
  }
});
