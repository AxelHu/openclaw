/**
 * Feishu API retry helper for transient errors.
 *
 * Feishu rate-limits bot message sending (5 QPS per chat, 100/min per bot).
 * Transient overload errors (code 2200, 11232, HTTP 429) should be retried
 * with backoff rather than dropped.
 *
 * (ported from 4.27 commit f3871d28604 — extracted to its own module for reuse)
 */

// --- Retryable Feishu API error codes ---
const RETRYABLE_FEISHU_ERROR_CODES = new Set([
  2200, // Internal server error (often triggered by rate pressure)
  11232, // Message API flow control
]);

export function extractFeishuErrorCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  // SDK error shape: err.code
  const code = (err as { code?: number }).code;
  if (typeof code === "number") return code;
  // AxiosError shape: err.response.data.code
  const response = (err as { response?: { data?: { code?: number } } }).response;
  if (typeof response?.data?.code === "number") return response.data.code;
  // HTTP status (e.g. 429)
  const status =
    (err as { response?: { status?: number } }).response?.status ??
    (err as { status?: number }).status;
  if (typeof status === "number") return status;
  return undefined;
}

export function isRetryableFeishuError(err: unknown): boolean {
  const code = extractFeishuErrorCode(err);
  if (code === undefined) return false;
  return RETRYABLE_FEISHU_ERROR_CODES.has(code) || code === 429;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SEND_MAX_RETRIES = 3;
const SEND_INITIAL_DELAY_MS = 300;

/** Execute an async function with retry on transient Feishu API errors.
 *  Uses exponential backoff: 300ms → 600ms → 1200ms. */
export async function withFeishuRetry<T>(
  fn: () => Promise<T>,
  log?: (message: string) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SEND_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableFeishuError(err) || attempt === SEND_MAX_RETRIES - 1) {
        throw err;
      }
      const delay = SEND_INITIAL_DELAY_MS * Math.pow(2, attempt);
      log?.(
        `feishu: retryable error (code=${extractFeishuErrorCode(err)}), ` +
          `retrying in ${delay}ms (attempt ${attempt + 1}/${SEND_MAX_RETRIES})`,
      );
      await sleep(delay);
    }
  }
  throw lastError; // unreachable, but satisfies TypeScript
}
