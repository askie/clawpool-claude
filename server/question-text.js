function normalizeString(value) {
  return String(value ?? "").trim();
}

function formatOptions(question) {
  if (!Array.isArray(question?.options) || question.options.length === 0) {
    return [];
  }

  const labels = question.options
    .map((option) => normalizeString(option?.label))
    .filter((label) => label);
  if (labels.length === 0) {
    return [];
  }

  return [
    `   Options: ${labels.join(" | ")}`,
  ];
}

export function buildQuestionAnswerCommandHint(request) {
  const requestID = normalizeString(request.request_id);
  const questions = Array.isArray(request.questions) ? request.questions : [];
  if (questions.length === 1) {
    return `/clawpool-question ${requestID} your answer`;
  }
  return `/clawpool-question ${requestID} 1=first answer; 2=second answer`;
}

export function buildQuestionFooterText() {
  return "Free text is allowed when none of the listed options fit.";
}

export function buildQuestionRequestText(request) {
  const requestID = normalizeString(request.request_id);
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const lines = [
    "Claude needs more input to continue this ClawPool turn.",
    `Request ID: ${requestID}`,
  ];

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

  lines.push(`Answer: ${buildQuestionAnswerCommandHint(request)}`);
  lines.push(buildQuestionFooterText());
  return lines.join("\n");
}

export function buildQuestionResponseText({ requestID }) {
  return `Question request ${requestID} answers recorded.`;
}
