import path from "node:path";
import { readFile, stat } from "node:fs/promises";

const maxReplyFileBytes = 50 * 1024 * 1024;

const uploadableFileExtensions = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "heic",
  "heif",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
  "avi",
]);

function normalizeString(value) {
  return String(value ?? "").trim();
}

function extensionOf(fileName) {
  const extension = path.extname(normalizeString(fileName)).toLowerCase();
  return extension.startsWith(".") ? extension.slice(1) : extension;
}

export function resolveAttachmentType(contentType) {
  const normalized = normalizeString(contentType).toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  return "file";
}

export function resolveContentType(fileName) {
  switch (extensionOf(fileName)) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "m4v":
      return "video/x-m4v";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "xml":
      return "application/xml";
    case "zip":
      return "application/zip";
    case "rar":
      return "application/vnd.rar";
    case "7z":
      return "application/x-7z-compressed";
    case "tar":
      return "application/x-tar";
    case "gz":
      return "application/gzip";
    default:
      return "application/octet-stream";
  }
}

export async function readReplyFile(filePath) {
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath) {
    throw new Error("reply.files entries must be non-empty absolute paths");
  }
  if (!path.isAbsolute(normalizedPath)) {
    throw new Error(`reply.files requires an absolute path: ${normalizedPath}`);
  }

  const fileStat = await stat(normalizedPath);
  if (!fileStat.isFile()) {
    throw new Error(`reply.files path is not a file: ${normalizedPath}`);
  }
  if (fileStat.size <= 0) {
    throw new Error(`reply.files path is empty: ${normalizedPath}`);
  }
  if (fileStat.size > maxReplyFileBytes) {
    throw new Error(`reply.files exceeds 50MB: ${normalizedPath}`);
  }

  const fileName = path.basename(normalizedPath);
  const extension = extensionOf(fileName);
  if (!extension || !uploadableFileExtensions.has(extension)) {
    throw new Error(`reply.files unsupported file type: ${fileName}`);
  }

  const contentType = resolveContentType(fileName);
  const attachmentType = resolveAttachmentType(contentType);
  const bytes = await readFile(normalizedPath);
  return {
    file_path: normalizedPath,
    file_name: fileName,
    content_type: contentType,
    attachment_type: attachmentType,
    bytes,
  };
}

export function buildAttachmentExtra({ attachmentType, fileName, accessURL, contentType }) {
  const attachment = {
    media_url: normalizeString(accessURL),
    attachment_type: normalizeString(attachmentType),
    file_name: normalizeString(fileName),
    content_type: normalizeString(contentType),
  };
  return {
    ...attachment,
    attachments: [attachment],
  };
}
