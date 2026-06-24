// 6/24 PATCH: Tests for video placeholder filter and downgrade logic.
// transform-messages.ts was extended to support VideoContent in:
// - replaceImagesWithPlaceholder (filter video if model doesn't support)
// - downgradeUnsupportedImages (separate image/video capability check)
// - Model.input.includes("video") check (skip filter if model supports)

import { describe, expect, it } from "vitest";
import type { Message, Model, VideoContent } from "../types.js";
import { transformMessages } from "./transform-messages.js";

const makeModel = (input: Array<"text" | "image" | "video">): Model<"anthropic-messages"> => ({
  id: "test-model",
  name: "Test Model",
  provider: "minimax",
  api: "anthropic-messages",
  baseUrl: "https://api.minimaxi.com/anthropic",
  reasoning: false,
  input,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 4096,
});

const videoBlock: VideoContent = {
  type: "video",
  mimeType: "video/mp4",
  data: "base64videodata==",
};

const imageBlock = {
  type: "image" as const,
  data: "base64imagedata==",
  mimeType: "image/jpeg" as const,
};

describe("transformMessages - video support (6/24 PATCH)", () => {
  describe("model with video + image support (minimax M3)", () => {
    it("preserves both image and video blocks in user message", () => {
      const model = makeModel(["text", "image", "video"]);
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Describe both." }, imageBlock, videoBlock],
          timestamp: 0,
        },
      ];

      const result = transformMessages(messages, model);

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.content).toEqual([
        { type: "text", text: "Describe both." },
        imageBlock,
        videoBlock,
      ]);
    });

    it("preserves video block alone in user message", () => {
      const model = makeModel(["text", "image", "video"]);
      const messages: Message[] = [
        {
          role: "user",
          content: [videoBlock],
          timestamp: 0,
        },
      ];

      const result = transformMessages(messages, model);

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.content).toEqual([videoBlock]);
    });

    it("preserves video in toolResult", () => {
      const model = makeModel(["text", "image", "video"]);
      const messages: Message[] = [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "fetchVideo",
          content: [{ type: "text", text: "video tool output:" }, videoBlock],
          isError: false,
          timestamp: 0,
        },
      ];

      const result = transformMessages(messages, model);

      const toolMessage = result.find((m) => m.role === "toolResult");
      expect(toolMessage?.content).toEqual([
        { type: "text", text: "video tool output:" },
        videoBlock,
      ]);
    });
  });

  describe("model without video support (e.g. M2.7, M2.5)", () => {
    it("replaces video block with placeholder, keeps image", () => {
      const model = makeModel(["text", "image"]);
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Look at these." }, imageBlock, videoBlock],
          timestamp: 0,
        },
      ];

      const result = transformMessages(messages, model);

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.content).toEqual([
        { type: "text", text: "Look at these." },
        imageBlock,
        { type: "text", text: "(video omitted: model does not support videos)" },
      ]);
    });

    it("replaces video with placeholder, removes image too (text-only model)", () => {
      const model = makeModel(["text"]);
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Look at these." }, imageBlock, videoBlock],
          timestamp: 0,
        },
      ];

      const result = transformMessages(messages, model);

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.content).toEqual([
        { type: "text", text: "Look at these." },
        { type: "text", text: "(image omitted: model does not support images)" },
        { type: "text", text: "(video omitted: model does not support videos)" },
      ]);
    });

    it("replaces video with toolResult placeholder", () => {
      const model = makeModel(["text", "image"]);
      const messages: Message[] = [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "fetchVideo",
          content: [{ type: "text", text: "video result:" }, videoBlock],
          isError: false,
          timestamp: 0,
        },
      ];

      const result = transformMessages(messages, model);

      const toolMessage = result.find((m) => m.role === "toolResult");
      expect(toolMessage?.content).toEqual([
        { type: "text", text: "video result:" },
        { type: "text", text: "(tool video omitted: model does not support videos)" },
      ]);
    });
  });

  describe("image-only model (legacy behavior preserved)", () => {
    it("still replaces image with placeholder (no video filter needed)", () => {
      const model = makeModel(["text"]);
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Look at this." }, imageBlock],
          timestamp: 0,
        },
      ];

      const result = transformMessages(messages, model);

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.content).toEqual([
        { type: "text", text: "Look at this." },
        { type: "text", text: "(image omitted: model does not support images)" },
      ]);
    });
  });

  describe("text-only message (no image/video) - unchanged", () => {
    it("preserves text messages as-is", () => {
      const model = makeModel(["text", "image", "video"]);
      const messages: Message[] = [{ role: "user", content: "just text", timestamp: 0 }];

      const result = transformMessages(messages, model);

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.content).toBe("just text");
    });
  });
});
