import path from "node:path";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeTokens(text) {
  return normalizeString(text).split(/\s+/).filter(Boolean);
}

export function parseControlCommand(text) {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return { matched: false, command: "", args: {}, error: "" };
  }

  const tokens = normalizeTokens(normalizedText);
  if (tokens.length === 0) {
    return { matched: false, command: "", args: {}, error: "" };
  }

  let startIndex = 0;
  if (tokens[0] === "/grix" || tokens[0] === "grix") {
    startIndex = 1;
  }

  const command = normalizeString(tokens[startIndex]).toLowerCase();
  if (!command) {
    return { matched: false, command: "", args: {}, error: "" };
  }

  if (command === "open") {
    const cwd = normalizeString(tokens.slice(startIndex + 1).join(" "));
    if (!cwd) {
      return { matched: true, ok: false, command, args: {}, error: "open 缺少目录路径。" };
    }
    return {
      matched: true,
      ok: true,
      command,
      args: {
        cwd: path.resolve(cwd),
      },
      error: "",
    };
  }

  if (command === "status" || command === "stop" || command === "where") {
    return {
      matched: true,
      ok: true,
      command,
      args: {},
      error: "",
    };
  }

  return { matched: false, command: "", args: {}, error: "" };
}
