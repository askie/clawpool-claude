import { normalizeElicitationFields } from "./elicitation-schema.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function parseBooleanValue(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  throw new Error("boolean answers must be yes or no");
}

function parseNumericValue(value, integerOnly) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error("answer is required");
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(integerOnly ? "answer must be an integer" : "answer must be a number");
  }
  if (integerOnly && !Number.isInteger(parsed)) {
    throw new Error("answer must be an integer");
  }
  return parsed;
}

function matchOption(value, options) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }
  const direct = options.find((option) => option === normalized);
  if (direct) {
    return direct;
  }
  const folded = normalized.toLowerCase();
  return options.find((option) => option.toLowerCase() === folded) || "";
}

function parseArrayValue(value, options) {
  const items = normalizeString(value)
    .split(",")
    .map((item) => normalizeString(item))
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error("at least one value is required");
  }

  if (!Array.isArray(options) || options.length === 0) {
    return items;
  }

  return items.map((item) => {
    const matched = matchOption(item, options);
    if (!matched) {
      throw new Error(`unsupported option: ${item}`);
    }
    return matched;
  });
}

function parseFieldValue(field, value) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    throw new Error(`${field.title} is required`);
  }

  switch (field.kind) {
    case "enum": {
      const matched = matchOption(normalizedValue, field.options);
      if (!matched) {
        throw new Error(`${field.title} must match one of the listed options`);
      }
      return matched;
    }
    case "number":
      return parseNumericValue(normalizedValue, false);
    case "integer":
      return parseNumericValue(normalizedValue, true);
    case "boolean":
      return parseBooleanValue(normalizedValue);
    case "string_array":
      return parseArrayValue(normalizedValue, []);
    case "enum_array":
      return parseArrayValue(normalizedValue, field.options);
    case "string":
    default:
      return normalizedValue;
  }
}

export function buildElicitationHookOutput(request, response) {
  const fields = normalizeElicitationFields(request?.fields);
  if (fields.length === 0) {
    throw new Error("elicitation request has no supported fields");
  }

  if (response?.type === "single") {
    if (fields.length !== 1) {
      throw new Error("multiple answers require 1=answer; 2=answer format");
    }

    return {
      action: "accept",
      content: {
        [fields[0].key]: parseFieldValue(fields[0], response.value),
      },
    };
  }

  if (response?.type !== "map" || !Array.isArray(response.entries)) {
    throw new Error("invalid elicitation response");
  }

  const content = {};
  const answeredIndexes = new Set();
  for (const entry of response.entries) {
    const key = normalizeString(entry?.key);
    const value = normalizeString(entry?.value);
    if (!/^[1-9][0-9]*$/u.test(key)) {
      throw new Error("elicitation answers must use numeric indexes like 1=answer");
    }
    if (!value) {
      throw new Error(`field ${key} answer is required`);
    }

    const index = Number(key);
    if (index < 1 || index > fields.length) {
      throw new Error(`field index ${index} is out of range`);
    }
    if (answeredIndexes.has(index)) {
      throw new Error(`field index ${index} answered more than once`);
    }

    const field = fields[index - 1];
    answeredIndexes.add(index);
    content[field.key] = parseFieldValue(field, value);
  }

  if (answeredIndexes.size !== fields.length) {
    throw new Error(`expected ${fields.length} answers but received ${answeredIndexes.size}`);
  }

  return {
    action: "accept",
    content,
  };
}
