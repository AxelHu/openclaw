import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postMultipartRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_MINIMAX_FILES_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_CN_FILES_BASE_URL = "https://api.minimaxi.com";
export const DEFAULT_MINIMAX_FILE_MAX_BYTES = 512 * 1024 * 1024;

export type MinimaxFilePurpose =
  | "assistants"
  | "voice_clone"
  | "prompt_audio"
  | "t2a_async_input"
  | "video_understanding";

export type MinimaxUploadFileParams = {
  providerId: string;
  cfg: NonNullable<Parameters<typeof resolveApiKeyForProvider>[0]["cfg"]>;
  agentDir?: string;
  authStore?: Parameters<typeof resolveApiKeyForProvider>[0]["store"];
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  purpose: MinimaxFilePurpose;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
};

export type MinimaxUploadFileResult = {
  fileId: string;
  bytes?: number;
  fileName?: string;
};

function resolveBaseUrlOrigin(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    return new URL(normalized).origin;
  } catch {
    return undefined;
  }
}

function canonicalMinimaxProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "minimax-cn") {
    return "minimax";
  }
  if (normalized === "minimax-portal-cn") {
    return "minimax-portal";
  }
  return normalized;
}

function resolveConfiguredProvider(cfg: MinimaxUploadFileParams["cfg"], providerId: string) {
  return (
    cfg.models?.providers?.[providerId] ??
    cfg.models?.providers?.[canonicalMinimaxProviderId(providerId)]
  );
}

export function resolveMinimaxFilesBaseUrl(
  cfg: MinimaxUploadFileParams["cfg"],
  providerId: string,
): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const exactProvider = cfg.models?.providers?.[normalizedProviderId];
  const exactOrigin = resolveBaseUrlOrigin(exactProvider?.baseUrl);
  if (exactOrigin) {
    return exactOrigin;
  }
  if (normalizedProviderId.endsWith("-cn")) {
    return DEFAULT_MINIMAX_CN_FILES_BASE_URL;
  }
  return (
    resolveBaseUrlOrigin(resolveConfiguredProvider(cfg, normalizedProviderId)?.baseUrl) ??
    DEFAULT_MINIMAX_FILES_BASE_URL
  );
}

function fileIdString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

export function parseMinimaxUploadResponse(value: unknown): MinimaxUploadFileResult {
  const object = asOptionalRecord(value);
  if (!object) {
    throw new Error("MiniMax file upload returned an invalid response");
  }
  const baseResponse = asOptionalRecord(object.base_resp);
  if (typeof baseResponse?.status_code === "number" && baseResponse.status_code !== 0) {
    const message =
      typeof baseResponse.status_msg === "string" ? baseResponse.status_msg : "unknown error";
    throw new Error(`MiniMax file upload failed: ${message}`);
  }
  const nested = asOptionalRecord(object.file);
  const fileId = fileIdString(object.file_id) ?? fileIdString(nested?.file_id);
  if (!fileId) {
    throw new Error("MiniMax file upload response missing file_id");
  }
  const bytes =
    typeof object.bytes === "number"
      ? object.bytes
      : typeof nested?.bytes === "number"
        ? nested.bytes
        : undefined;
  const fileName =
    typeof object.filename === "string"
      ? object.filename
      : typeof nested?.filename === "string"
        ? nested.filename
        : undefined;
  return { fileId, ...(bytes !== undefined ? { bytes } : {}), ...(fileName ? { fileName } : {}) };
}

export async function uploadMinimaxFile(
  params: MinimaxUploadFileParams,
): Promise<MinimaxUploadFileResult> {
  if (params.buffer.byteLength > DEFAULT_MINIMAX_FILE_MAX_BYTES) {
    throw new Error(
      `MiniMax file upload exceeds ${DEFAULT_MINIMAX_FILE_MAX_BYTES} bytes (got ${params.buffer.byteLength})`,
    );
  }
  const auth = await resolveApiKeyForProvider({
    provider: params.providerId,
    cfg: params.cfg,
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.authStore ? { store: params.authStore } : {}),
  });
  if (!auth.apiKey) {
    throw new Error(`MiniMax API key not configured for provider ${params.providerId}`);
  }
  const providerConfig = resolveConfiguredProvider(params.cfg, params.providerId);
  const defaultBaseUrl = resolveMinimaxFilesBaseUrl(params.cfg, params.providerId);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: defaultBaseUrl,
      defaultBaseUrl,
      defaultHeaders: { Authorization: `Bearer ${auth.apiKey}` },
      provider: params.providerId,
      capability: "video",
      transport: "http",
      request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
    });
  const extension = extensionForMime(params.mimeType);
  const fileName =
    normalizeOptionalString(params.fileName) ??
    `video-${Date.now()}${extension ? `.${extension.replace(/^\./u, "")}` : ""}`;
  const body = new FormData();
  body.set("file", new Blob([new Uint8Array(params.buffer)], { type: params.mimeType }), fileName);
  body.set("purpose", params.purpose);
  const multipartHeaders = new Headers(headers);
  multipartHeaders.delete("Content-Type");
  const { response, release } = await postMultipartRequest({
    url: `${baseUrl}/v1/files/upload`,
    headers: multipartHeaders,
    body,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn ?? fetch,
    allowPrivateNetwork,
    dispatcherPolicy,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  try {
    await assertOkOrThrowHttpError(response, "MiniMax file upload failed");
    return parseMinimaxUploadResponse(
      await readProviderJsonResponse(response, "MiniMax file upload failed"),
    );
  } finally {
    await release();
  }
}
