import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { readJSONFile, writeJSONFileAtomic } from "../json-file.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeRecord(input = {}) {
  return {
    schema_version: 1,
    platform: normalizeString(input.platform),
    service_id: normalizeString(input.service_id),
    node_path: normalizeString(input.node_path),
    cli_path: normalizeString(input.cli_path),
    definition_path: normalizeString(input.definition_path),
    data_dir: normalizeString(input.data_dir),
    installed_at: Number(input.installed_at ?? 0),
    updated_at: Number(input.updated_at ?? 0),
  };
}

export class ServiceInstallStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    const record = await readJSONFile(this.filePath, null);
    return record ? normalizeRecord(record) : null;
  }

  async save(record) {
    const next = normalizeRecord(record);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeJSONFileAtomic(this.filePath, next, { mode: 0o600 });
    return next;
  }

  async clear() {
    await rm(this.filePath, { force: true });
  }
}
