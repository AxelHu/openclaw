// 6/24 PATCH: MiniMax Files API upload helper.
//
// MiniMax Files API (`POST /v1/files/upload`) supports uploading files that can be
// referenced via `mm_file://{file_id}` in chat completion / messages requests.
//
// Documented purposes (from platform.minimaxi.com/docs/api-reference/file-management-upload):
// - `voice_clone`        — voice cloning training data
// - `prompt_audio`       — voice sample for prompting
// - `t2a_async_input`    — async text-to-audio input
// - `video_understanding` — video files for M3 native video input
//
// IMPORTANT: For each call site, the caller must pass the correct `purpose` value
// explicitly. We do NOT default `purpose` to `video_understanding` because image
// and audio upload use cases (e.g. voice_clone, prompt_audio) need their own
// purpose. The default of `"assistants"` matches the most common OpenAI-style
// assistant file upload flow. Callers that need a different purpose must pass it
// explicitly (e.g. feishu video preflight passes `purpose: "video_understanding"`).
//
// See:
// - platform.minimaxi.com/docs/api-reference/file-management-upload
// - memory/2026-06-24-video-routes.md (老板 17:44 拍板: 不改默认值)
// - Agents/multimodal#4 (Gitea issue)

import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { assertOkOrThrowHttpError } from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_MINIMAX_BASE_URL, MINIMAX_CN_API_BASE_URL } from "./model-definitions.js";

const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // 512MB per MiniMax Files API docs

export type MinimaxFilePurpose =
  | "assistants"
  | "voice_clone"
  | "prompt_audio"
  | "t2a_async_input"
  | "video_understanding";

export type MinimaxUploadFileParams = {
  providerId: string;
  /** OpenClaw config (for resolving baseUrl + api key) */
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"];
  /** File bytes to upload */
  buffer: Buffer;
  /** MIME type (e.g. "video/mp4", "audio/mpeg", "image/jpeg") */
  mimeType: string;
  /** Original filename (optional, derived from mime type if omitted) */
  fileName?: string;
  /**
   * Upload purpose. Required — caller must specify the right purpose for the
   * upload context. See `MinimaxFilePurpose` for the documented values.
   *
   * For video M3 input: pass `"video_understanding"` so the file can be
   * referenced as `mm_file://{file_id}` in chat completion / messages requests.
   */
  purpose: MinimaxFilePurpose;
};

export type MinimaxUploadFileResult = {
  file_id: string;
  bytes?: number;
  filename?: string;
};

/**
 * Resolves the MiniMax API base URL for Files API upload.
 * MiniMax Files API uses the same base URL as the text / image / video APIs.
 * Prefer the provider's configured baseUrl if available; otherwise fall back
 * to the standard defaults.
 */
function resolveMinimaxFilesApiBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: string,
): string {
  const direct = normalizeOptionalString(cfg?.models?.providers?.[providerId]?.baseUrl);
  if (direct) {
    try {
      return new URL(direct).origin;
    } catch {
      // fall through
    }
  }
  // Both default and CN urls share the same origin host pattern; default to CN
  // (api.minimaxi.com) for the Files API since the test upload (#1) at 17:35
  // succeeded against api.minimaxi.com.
  return MINIMAX_CN_API_BASE_URL || DEFAULT_MINIMAX_BASE_URL;
}

/**
 * Uploads a file to MiniMax Files API and returns the file_id.
 * The file can then be referenced as `mm_file://{file_id}` in subsequent
 * chat completion / messages requests.
 *
 * NOTE: Callers must specify `purpose` explicitly. There is intentionally
 * no `defaultPurpose` parameter — see file header for rationale.
 */
export async function uploadMinimaxFile(
  params: MinimaxUploadFileParams,
): Promise<MinimaxUploadFileResult> {
  if (params.buffer.byteLength > DEFAULT_MAX_UPLOAD_BYTES) {
    throw new Error(
      `MiniMax file upload exceeds ${DEFAULT_MAX_UPLOAD_BYTES} bytes (got ${params.buffer.byteLength}); compress or split before uploading`,
    );
  }

  const auth = await resolveApiKeyForProvider({
    provider: params.providerId,
    cfg: params.cfg,
  });
  if (!auth.apiKey) {
    throw new Error(`MiniMax API key not configured for provider ${params.providerId}`);
  }

  const baseUrl = resolveMinimaxFilesApiBaseUrl(params.cfg, params.providerId);

  // Build multipart form data using Node 18+ global FormData + Blob.
  const ext = extensionForMime(params.mimeType);
  const resolvedFileName =
    params.fileName ?? `upload-${Date.now()}${ext ? `.${ext.slice(1)}` : ""}`;

  const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mimeType });
  const formData = new FormData();
  formData.append("file", blob, resolvedFileName);
  formData.append("purpose", params.purpose);

  // Note: do NOT set Content-Type header — fetch sets it with the correct
  // multipart boundary automatically.
  const response = await fetch(`${baseUrl}/v1/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.apiKey}`,
    },
    body: formData,
  });

  await assertOkOrThrowHttpError(response, "MiniMax file upload failed");

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`MiniMax file upload returned non-JSON response: ${body.slice(0, 200)}`);
  }

  return parseMinimaxUploadResponse(parsed);
}

function parseMinimaxUploadResponse(value: unknown): MinimaxUploadFileResult {
  if (!value || typeof value !== "object") {
    throw new Error("MiniMax file upload returned invalid response (not an object)");
  }
  const obj = value as Record<string, unknown>;

  // base_resp.status_code === 0 means success
  const baseResp = obj.base_resp as Record<string, unknown> | undefined;
  if (baseResp?.status_code !== undefined && baseResp.status_code !== 0) {
    const msg = typeof baseResp.status_msg === "string" ? baseResp.status_msg : "unknown error";
    throw new Error(`MiniMax file upload failed: ${msg}`);
  }

  // File ID may be at the top level or under `file`
  const file = obj.file as Record<string, unknown> | undefined;
  const fileId =
    typeof obj.file_id === "string"
      ? obj.file_id
      : typeof file?.file_id === "string"
        ? file.file_id
        : null;
  if (!fileId) {
    throw new Error("MiniMax file upload response missing file_id");
  }

  const filename =
    typeof obj.filename === "string"
      ? obj.filename
      : typeof file?.filename === "string"
        ? file.filename
        : undefined;
  const bytes =
    typeof obj.bytes === "number"
      ? obj.bytes
      : typeof file?.bytes === "number"
        ? file.bytes
        : undefined;

  return { file_id: fileId, bytes, filename };
}

export const __testing = {
  DEFAULT_MAX_UPLOAD_BYTES,
  resolveMinimaxFilesApiBaseUrl,
  parseMinimaxUploadResponse,
};
