function normalizeErrorText(raw: string): string {
  return raw.toLowerCase().replace(/[\s_-]+/gu, " ");
}

/**
 * Narrowly matches provider errors that explicitly identify image sensitivity
 * rejection. Generic image schema, transport, and capability errors stay out.
 */
export function isSensitiveImageRejectionError(raw?: string): boolean {
  if (!raw) {
    return false;
  }
  const normalized = normalizeErrorText(raw);
  if (normalized.includes("new sensitive") && normalized.includes("image")) {
    return true;
  }
  if (normalized.includes("image is sensitive")) {
    return true;
  }
  return (
    normalized.includes("image") &&
    normalized.includes("sensitive") &&
    /messages?\[\d+\].*content\[\d+\]/iu.test(raw)
  );
}

export function formatSensitiveImageRejectionErrorCopy(raw: string): string | undefined {
  return isSensitiveImageRejectionError(raw)
    ? "LLM request failed: provider rejected a recent image block as sensitive. " +
        "Continue without assuming that image is available; retry with a different image if needed."
    : undefined;
}
