import { chmod, readFile, rename, writeFile } from "node:fs/promises";

export async function readJSONFile(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallbackValue;
    }
    if (error instanceof SyntaxError) {
      return fallbackValue;
    }
    throw error;
  }
}

export async function writeJSONFileAtomic(filePath, value, { mode = 0o600 } = {}) {
  const tmpPath = `${filePath}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmpPath, text, {
    encoding: "utf8",
    mode,
  });
  await rename(tmpPath, filePath);
  try {
    await chmod(filePath, mode);
  } catch {
    // chmod can be unsupported or ineffective on some platforms
  }
}
