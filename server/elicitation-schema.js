function normalizeString(value) {
  return String(value ?? "").trim();
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((value) => normalizeString(value))
    .filter(Boolean);
}

function normalizeFieldType(value) {
  const normalized = normalizeString(value).toLowerCase();
  return normalized || "string";
}

function normalizeFieldKind(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return "string";
  }
  return normalized;
}

function normalizeFieldPrompt(title, description, kind) {
  const lines = [];
  const normalizedDescription = normalizeString(description);
  if (normalizedDescription) {
    lines.push(normalizedDescription);
  }

  const typeHint = {
    string: "Enter text.",
    number: "Enter a number.",
    integer: "Enter an integer.",
    boolean: "Choose yes or no.",
    enum: "Choose one of the listed options.",
    string_array: "Enter one or more values, separated by commas.",
    enum_array: "Choose one or more of the listed options.",
  }[normalizeFieldKind(kind)] || "";

  if (typeHint) {
    lines.push(typeHint);
  }

  return lines.join(" ").trim() || `Provide ${normalizeString(title) || "a value"}.`;
}

function normalizeFieldOptions(input) {
  return normalizeStringArray(input);
}

function buildSupportedResult(fields) {
  return {
    supported: true,
    reason: "",
    fields,
  };
}

function buildUnsupportedResult(reason) {
  return {
    supported: false,
    reason: normalizeString(reason) || "unsupported_schema",
    fields: [],
  };
}

function buildFieldFromProperty(key, propertySchema) {
  const schema = isRecord(propertySchema) ? propertySchema : {};
  const title = normalizeString(schema.title) || key;
  const description = normalizeString(schema.description);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const options = normalizeFieldOptions(schema.enum);
    if (options.length === 0) {
      return null;
    }
    return {
      key,
      title,
      prompt: normalizeFieldPrompt(title, description, "enum"),
      type: "string",
      kind: "enum",
      options,
      multi_select: false,
      required: true,
    };
  }

  const type = normalizeFieldType(schema.type);
  if (type === "string" || !normalizeString(schema.type)) {
    return {
      key,
      title,
      prompt: normalizeFieldPrompt(title, description, "string"),
      type: "string",
      kind: "string",
      options: [],
      multi_select: false,
      required: true,
    };
  }

  if (type === "number") {
    return {
      key,
      title,
      prompt: normalizeFieldPrompt(title, description, "number"),
      type: "number",
      kind: "number",
      options: [],
      multi_select: false,
      required: true,
    };
  }

  if (type === "integer") {
    return {
      key,
      title,
      prompt: normalizeFieldPrompt(title, description, "integer"),
      type: "integer",
      kind: "integer",
      options: [],
      multi_select: false,
      required: true,
    };
  }

  if (type === "boolean") {
    return {
      key,
      title,
      prompt: normalizeFieldPrompt(title, description, "boolean"),
      type: "boolean",
      kind: "boolean",
      options: ["yes", "no"],
      multi_select: false,
      required: true,
    };
  }

  if (type === "array") {
    const itemSchema = isRecord(schema.items) ? schema.items : {};
    const itemType = normalizeFieldType(itemSchema.type);
    if (Array.isArray(itemSchema.enum) && itemSchema.enum.length > 0) {
      const options = normalizeFieldOptions(itemSchema.enum);
      if (options.length === 0) {
        return null;
      }
      return {
        key,
        title,
        prompt: normalizeFieldPrompt(title, description, "enum_array"),
        type: "array",
        kind: "enum_array",
        options,
        multi_select: true,
        required: true,
      };
    }

    if (itemType === "string" || !normalizeString(itemSchema.type)) {
      return {
        key,
        title,
        prompt: normalizeFieldPrompt(title, description, "string_array"),
        type: "array",
        kind: "string_array",
        options: [],
        multi_select: true,
        required: true,
      };
    }

    return null;
  }

  return null;
}

export function deriveSupportedElicitationFields(requestedSchema) {
  const schema = isRecord(requestedSchema) ? requestedSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties || Object.keys(properties).length === 0) {
    return buildUnsupportedResult("requested schema must be a flat object");
  }

  const propertyKeys = Object.keys(properties);
  const requiredKeys = new Set(normalizeStringArray(schema.required));
  if (requiredKeys.size !== propertyKeys.length || propertyKeys.some((key) => !requiredKeys.has(key))) {
    return buildUnsupportedResult("optional elicitation fields are not supported by the remote card");
  }

  const fields = [];
  for (const key of propertyKeys) {
    const field = buildFieldFromProperty(key, properties[key]);
    if (!field) {
      return buildUnsupportedResult(`requested schema field ${key} is not supported by the remote card`);
    }
    fields.push(field);
  }

  return buildSupportedResult(fields);
}

export function normalizeElicitationFields(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((field) => {
      const key = normalizeString(field?.key);
      const title = normalizeString(field?.title) || key;
      if (!key || !title) {
        return null;
      }
      return {
        key,
        title,
        prompt: normalizeString(field?.prompt) || normalizeFieldPrompt(title, "", field?.kind),
        type: normalizeFieldType(field?.type),
        kind: normalizeFieldKind(field?.kind),
        options: normalizeFieldOptions(field?.options),
        multi_select: field?.multi_select === true,
        required: field?.required !== false,
      };
    })
    .filter(Boolean);
}

export function buildQuestionPromptsFromFields(fields) {
  return normalizeElicitationFields(fields).map((field) => ({
    header: field.title,
    question: field.prompt,
    options: field.options.map((label) => ({ label })),
    multiSelect: field.multi_select,
  }));
}

export function cloneRequestedSchema(requestedSchema) {
  if (!isRecord(requestedSchema)) {
    return null;
  }
  return cloneJSON(requestedSchema);
}
