function normalizeString(value) {
  return String(value ?? "").trim();
}

function formatOptions(question) {
  if (!Array.isArray(question?.options) || question.options.length === 0) {
    return [];
  }

  const labels = question.options
    .map((option) => normalizeString(option?.label))
    .filter(Boolean);
  if (labels.length === 0) {
    return [];
  }

  return [
    `   Options: ${labels.join(" | ")}`,
  ];
}

export function buildElicitationFooterText() {
  return "Use the card to answer. Free text is allowed when none of the listed options fit.";
}

export function buildElicitationRequestText(request) {
  const lines = [
    "Claude needs more input to continue this Grix turn.",
  ];

  const message = normalizeString(request?.message);
  if (message) {
    lines.push(message);
  }

  const questions = Array.isArray(request?.questions) ? request.questions : [];
  questions.forEach((question, index) => {
    const header = normalizeString(question?.header) || `Question ${index + 1}`;
    const prompt = normalizeString(question?.question) || "(missing question text)";
    lines.push(`${index + 1}. ${header}`);
    lines.push(`   ${prompt}`);
    lines.push(...formatOptions(question));
    if (question?.multiSelect === true) {
      lines.push("   Multiple selections: join values with commas.");
    }
  });

  lines.push(buildElicitationFooterText());
  return lines.join("\n");
}

export function buildElicitationResponseText({ requestID }) {
  return `Input request ${requestID} answers recorded.`;
}
