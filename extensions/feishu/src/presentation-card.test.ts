import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import {
  buildFeishuPresentationCardElements,
  isFeishuCardWithinEnvelope,
} from "./presentation-card.js";

describe("buildFeishuPresentationCardElements", () => {
  it("preserves valid Feishu mentions while escaping surrounding presentation text", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        { type: "text", text: 'hello <at user_id="ou_target">Target</a> <unsafe>' },
        { type: "context", text: '<at id="ou_second">Second</at> </font>' },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCardElements({ presentation })).toEqual([
      {
        tag: "markdown",
        content: "hello <at id=ou_target>Target</at> &lt;unsafe&gt;",
      },
      {
        tag: "markdown",
        content: "<font color='grey'><at id=ou_second>Second</at> &lt;/font&gt;</font>",
      },
    ]);
  });

  it("renders table blocks through the portable text fallback", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCardElements({ presentation })).toEqual([
      {
        tag: "markdown",
        content:
          "Pipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      },
    ]);
  });
});

describe("isFeishuCardWithinEnvelope", () => {
  it("counts nested elements against the 200-element API limit", () => {
    const buildCard = (elementCount: number) => ({
      schema: "2.0",
      body: {
        elements: Array.from({ length: elementCount }, (_entry, index) => ({
          tag: "markdown",
          content: String(index),
        })),
      },
    });

    expect(isFeishuCardWithinEnvelope(buildCard(200))).toBe(true);
    expect(isFeishuCardWithinEnvelope(buildCard(201))).toBe(false);
  });
});
