/**
 * Sanitizes historical embedded-agent message images and empty content blocks.
 */
import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import { sanitizeInlineVideoBase64 } from "@openclaw/media-core/inline-image-data-url";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];
const EMPTY_CONTENT_PLACEHOLDER = "[empty content omitted]";
const CORRUPTED_VIDEO_FALLBACK_TEXT = "[video omitted: corrupted base64 payload]";

function sanitizeLegacyInlineVideoBlocks<T>(content: T[]): T[] {
  return content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return block;
    }
    // SAFETY: the guard above narrows block to a non-null, non-array object; fields remain unknown until checked.
    const record = block as Record<string, unknown>;
    if (record.type !== "video" || typeof record.data !== "string") {
      return block;
    }
    const mimeField = ["mimeType", "mediaType", "media_type"].find((key) => {
      const value = record[key];
      return typeof value === "string" && /^video\//iu.test(value.trim());
    });
    if (!mimeField) {
      return block;
    }
    const mimeType = String(record[mimeField]).trim().toLowerCase();
    const sanitized = sanitizeInlineVideoBase64({ mimeType, base64: record.data });
    if (!sanitized) {
      // SAFETY: callers pass transcript content-block unions that admit text blocks; this replaces only an invalid legacy video block.
      return { type: "text", text: CORRUPTED_VIDEO_FALLBACK_TEXT } as T;
    }
    if (sanitized.base64 === record.data && sanitized.mimeType === mimeType) {
      return block;
    }
    const next: Record<string, unknown> = { ...record, data: sanitized.base64 };
    for (const key of ["mimeType", "mediaType", "media_type"] as const) {
      if (typeof record[key] === "string" && /^video\//iu.test(record[key].trim())) {
        next[key] = sanitized.mimeType;
      }
    }
    // SAFETY: next preserves the original runtime block shape and only canonicalizes validated video payload fields.
    return next as T;
  });
}

function dropEmptyTextBlocks<T>(content: T[]): T[] {
  return content.filter((block) => {
    const rec = block as { type?: unknown; text?: unknown };
    return (
      !block ||
      typeof block !== "object" ||
      rec.type !== "text" ||
      typeof rec.text !== "string" ||
      rec.text.trim().length > 0
    );
  });
}

function ensureNonEmptyContent<T>(content: T[]): T[] {
  if (content.length > 0) {
    return content;
  }
  return [{ type: "text", text: EMPTY_CONTENT_PLACEHOLDER }] as T[];
}

/** Resize/remove unsafe image payloads while keeping transcript turns valid. */
export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
  options?: {
    sanitizeMode?: "full" | "images-only";
    sanitizeToolCallIds?: boolean;
    preserveNativeAnthropicToolUseIds?: boolean;
    duplicateToolCallIdStyle?: "openai";
    /**
     * Mode for tool call ID sanitization:
     * - "strict" (alphanumeric only)
     * - "strict9" (alphanumeric only, length 9)
     */
    toolCallIdMode?: ToolCallIdMode;
    preserveSignatures?: boolean;
    sanitizeThoughtSignatures?: {
      allowBase64Only?: boolean;
      includeCamelCase?: boolean;
    };
  } & ImageSanitizationLimits,
): Promise<AgentMessage[]> {
  const imageSanitization = {
    maxDimensionPx: options?.maxDimensionPx,
    maxBytes: options?.maxBytes,
  };
  const shouldSanitizeToolCallIds = options?.sanitizeToolCallIds === true;
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (default max side 1200px).
  const sanitizedIds = shouldSanitizeToolCallIds
    ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode, {
        preserveNativeAnthropicToolUseIds: options?.preserveNativeAnthropicToolUseIds,
        duplicateToolCallIdStyle: options?.duplicateToolCallIdStyle,
      })
    : messages;
  const out: AgentMessage[] = [];
  for (const msg of sanitizedIds) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
      const nextContent = await sanitizeContentBlocksImages(
        sanitizeLegacyInlineVideoBlocks(content),
        label,
        imageSanitization,
      );
      out.push({ ...toolMsg, content: ensureNonEmptyContent(dropEmptyTextBlocks(nextContent)) });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = await sanitizeContentBlocksImages(
          sanitizeLegacyInlineVideoBlocks(content),
          label,
          imageSanitization,
        );
        out.push({ ...userMsg, content: ensureNonEmptyContent(dropEmptyTextBlocks(nextContent)) });
        continue;
      }
    }

    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      const content = assistantMsg.content;
      if (Array.isArray(content)) {
        const strippedContent =
          assistantMsg.stopReason === "error" || options?.preserveSignatures
            ? content // Keep signatures for Antigravity Claude
            : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures); // Strip for Gemini
        const finalContent = (await sanitizeContentBlocksImages(
          sanitizeLegacyInlineVideoBlocks(
            dropEmptyTextBlocks(strippedContent) as unknown as ContentBlock[],
          ),
          label,
          imageSanitization,
        )) as unknown as typeof assistantMsg.content;
        if (finalContent.length > 0 || assistantMsg.providerReplay) {
          out.push(replaceCompactionReplayOwnerContent(assistantMsg, finalContent));
        }
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
