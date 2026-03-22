import { readReplyFile, buildAttachmentExtra } from "./attachment-file.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function trimTrailingSlash(value) {
  return normalizeString(value).replace(/\/+$/u, "");
}

function parseJSONResponseBody(text) {
  if (!normalizeString(text)) {
    return {};
  }
  return JSON.parse(text);
}

export function resolveAgentAPIPresignURL(wsURL) {
  const url = new URL(normalizeString(wsURL));
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("ws_url must start with ws:// or wss://");
  }

  const basePath = trimTrailingSlash(url.pathname).replace(/\/ws$/u, "");
  if (!basePath || basePath === trimTrailingSlash(url.pathname)) {
    throw new Error("ws_url must end with /ws");
  }

  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `${basePath}/oss/presign`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function requestPresign({ wsURL, apiKey, sessionID, fileName, contentType, fetchImpl }) {
  const response = await fetchImpl(resolveAgentAPIPresignURL(wsURL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizeString(apiKey)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: normalizeString(sessionID),
      filename: normalizeString(fileName),
      content_type: normalizeString(contentType),
    }),
  });

  const rawBody = await response.text();
  const payload = parseJSONResponseBody(rawBody);
  if (!response.ok || Number(payload?.code ?? -1) !== 0) {
    const message = normalizeString(payload?.msg) || response.statusText || "agent media presign failed";
    throw new Error(`agent media presign failed: ${message}`);
  }

  const uploadURL = normalizeString(payload?.data?.upload_url);
  const accessURL = normalizeString(payload?.data?.media_access_url);
  if (!uploadURL || !accessURL) {
    throw new Error("agent media presign returned incomplete upload_url/media_access_url");
  }

  return {
    upload_url: uploadURL,
    access_url: accessURL,
  };
}

async function uploadPresignedFile({ uploadURL, contentType, bytes, fetchImpl }) {
  const response = await fetchImpl(uploadURL, {
    method: "PUT",
    headers: {
      "Content-Type": normalizeString(contentType),
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`agent media upload failed: ${response.status} ${response.statusText}`);
  }
}

export async function uploadReplyFileToAgentMedia({
  wsURL,
  apiKey,
  sessionID,
  filePath,
  fetchImpl = fetch,
}) {
  const file = await readReplyFile(filePath);
  const presign = await requestPresign({
    wsURL,
    apiKey,
    sessionID,
    fileName: file.file_name,
    contentType: file.content_type,
    fetchImpl,
  });
  await uploadPresignedFile({
    uploadURL: presign.upload_url,
    contentType: file.content_type,
    bytes: file.bytes,
    fetchImpl,
  });
  return {
    ...file,
    access_url: presign.access_url,
    extra: buildAttachmentExtra({
      attachmentType: file.attachment_type,
      fileName: file.file_name,
      accessURL: presign.access_url,
      contentType: file.content_type,
    }),
  };
}
