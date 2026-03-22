import { readFile, rename, writeFile } from "node:fs/promises";

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

export async function writeJSONFileAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, filePath);
}
