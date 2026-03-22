function normalizeString(value) {
  return String(value ?? "").trim();
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeQuestions(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((question) => {
      const prompt = normalizeString(question?.question);
      if (!prompt) {
        return null;
      }
      return {
        question: prompt,
        header: normalizeString(question?.header),
        options: Array.isArray(question?.options) ? cloneJSON(question.options) : [],
        multiSelect: question?.multiSelect === true,
      };
    })
    .filter(Boolean);
}

export function buildAskUserQuestionUpdatedInput(request, response) {
  const questions = normalizeQuestions(request?.questions);
  if (questions.length === 0) {
    throw new Error("question request has no questions");
  }

  if (response?.type === "single") {
    if (questions.length !== 1) {
      throw new Error("multiple questions require 1=answer; 2=answer format");
    }

    const answer = normalizeString(response.value);
    if (!answer) {
      throw new Error("answer is required");
    }

    return {
      questions,
      answers: {
        [questions[0].question]: answer,
      },
    };
  }

  if (response?.type !== "map" || !Array.isArray(response.entries)) {
    throw new Error("invalid question response");
  }

  const answers = {};
  const answeredIndexes = new Set();
  for (const entry of response.entries) {
    const key = normalizeString(entry?.key);
    const value = normalizeString(entry?.value);
    if (!/^[1-9][0-9]*$/u.test(key)) {
      throw new Error("question answers must use numeric indexes like 1=answer");
    }
    if (!value) {
      throw new Error(`question ${key} answer is required`);
    }

    const index = Number(key);
    if (index < 1 || index > questions.length) {
      throw new Error(`question index ${index} is out of range`);
    }
    if (answeredIndexes.has(index)) {
      throw new Error(`question index ${index} answered more than once`);
    }

    answeredIndexes.add(index);
    answers[questions[index - 1].question] = value;
  }

  if (answeredIndexes.size !== questions.length) {
    throw new Error(`expected ${questions.length} answers but received ${answeredIndexes.size}`);
  }

  return {
    questions,
    answers,
  };
}
