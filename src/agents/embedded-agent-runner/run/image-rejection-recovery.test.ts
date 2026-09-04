import { describe, expect, it } from "vitest";
import { readPersistedMediaFacts } from "../../../media/media-facts.js";
import { isSensitiveImageRejectionError } from "../../embedded-agent-helpers/image-rejection-error.js";
import { SessionManager } from "../../sessions/index.js";
import { recoverRecentSensitiveImageRejection } from "./image-rejection-recovery.js";

const EXPECTED_IMAGE_REJECTION_PLACEHOLDER =
  "[image data removed after the provider rejected a recent image as sensitive; the original image is no longer included in prompt history]";
const EXPECTED_IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE = "openclaw:image-rejection-recovery";

const SENSITIVE_ERROR =
  "input new_sensitive, messages[18]'s content[1] image is sensitive, please check your input (1026)";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

function imageToolResult(label: string): AppendMessage {
  return asAppendMessage({
    role: "toolResult",
    toolCallId: `call-${label}`,
    toolName: "read",
    content: [
      { type: "text", text: `Read image ${label}` },
      { type: "image", data: `${label}-bytes`, mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 1,
  });
}

function imageCount(message: unknown): number {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter(
    (block) =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image",
  ).length;
}

describe("sensitive image rejection recovery", () => {
  it("matches explicit sensitive-image errors but not generic image failures", () => {
    expect(isSensitiveImageRejectionError(SENSITIVE_ERROR)).toBe(true);
    expect(isSensitiveImageRejectionError("400 image is sensitive, please check your input")).toBe(
      true,
    );
    expect(isSensitiveImageRejectionError("400 invalid image schema: missing mime type")).toBe(
      false,
    );
    expect(isSensitiveImageRejectionError("model does not support images")).toBe(false);
  });

  it("rewrites only the most recent image-bearing transcript message", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(imageToolResult("old"));
    manager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "old image handled" }],
        timestamp: 2,
      }),
    );
    manager.appendMessage(imageToolResult("recent"));

    const result = recoverRecentSensitiveImageRejection({
      sessionManager: manager,
      rawError: SENSITIVE_ERROR,
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(result).toMatchObject({ recovered: true, imageBlocks: 1, rewrittenEntries: 1 });
    const messages = manager
      .getBranch()
      .filter(
        (entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message",
      )
      .map((entry) => entry.message);
    const toolResults = messages.filter((message) => message.role === "toolResult");
    expect(toolResults).toHaveLength(2);
    expect(imageCount(toolResults[0])).toBe(1);
    expect(imageCount(toolResults[1])).toBe(0);
    expect(JSON.stringify(toolResults[1])).toContain(EXPECTED_IMAGE_REJECTION_PLACEHOLDER);
    expect(
      manager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === EXPECTED_IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE,
        ),
    ).toBe(true);
  });

  it("suppresses persisted image facts so replay cannot rehydrate the rejected image", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "inspect this attachment",
        timestamp: 1,
        __openclaw: {
          media: [
            {
              path: "/tmp/rejected.png",
              contentType: "image/png",
              kind: "image",
            },
          ],
          mediaImageLayout: {
            slots: [{ kind: "offloaded", factIndex: 0 }],
            suppressedFactIndexes: [],
          },
          mediaImageBlockFactIndexes: [0],
        },
      }),
    );

    const result = recoverRecentSensitiveImageRejection({
      sessionManager: manager,
      rawError: SENSITIVE_ERROR,
    });

    expect(result).toMatchObject({
      recovered: true,
      imageBlocks: 0,
      suppressedMediaFacts: 1,
      rewrittenEntries: 1,
    });
    const user = manager
      .getBranch()
      .findLast(
        (entry): entry is Extract<typeof entry, { type: "message" }> =>
          entry.type === "message" && entry.message.role === "user",
      )?.message;
    expect(user).toBeDefined();
    const userContent = (user as unknown as { content?: unknown } | undefined)?.content;
    expect(String(userContent)).toContain(EXPECTED_IMAGE_REJECTION_PLACEHOLDER);
    expect(readPersistedMediaFacts(user as object)?.[0]).toMatchObject({
      path: "/tmp/rejected.png",
      hydrationSuppressed: true,
    });
    expect(
      (user as unknown as { __openclaw?: Record<string, unknown> })["__openclaw"],
    ).toMatchObject({
      mediaImageLayout: {
        slots: [{ kind: "offloaded", factIndex: 0 }],
        suppressedFactIndexes: [0],
      },
    });
    expect(
      (user as unknown as { __openclaw?: Record<string, unknown> })["__openclaw"],
    ).not.toHaveProperty("mediaImageBlockFactIndexes");
  });

  it("leaves the transcript unchanged for unrelated provider failures", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(imageToolResult("kept"));
    const before = JSON.stringify(manager.getBranch());

    expect(
      recoverRecentSensitiveImageRejection({
        sessionManager: manager,
        rawError: "429 rate limit exceeded",
      }),
    ).toMatchObject({ recovered: false, rewrittenEntries: 0 });
    expect(JSON.stringify(manager.getBranch())).toBe(before);
  });
});
