import { describe, expect, it } from "vitest";
import { extractMentionTagsFromText, normalizeTextAtTagClosing } from "./mention.js";

const AXEL = "ou_26017038b6a47116c3e97c509650a09c";
const HUNTER = "ou_c4d78231f12e09badfd77b013d3f0749";

describe("normalizeTextAtTagClosing", () => {
  it("fixes </a> closing for user_id format (post text style)", () => {
    expect(
      normalizeTextAtTagClosing(
        `<at user_id="${AXEL}">AxelHu</a> 收到，就这次单独加，不写到 AGENTS.md 推广。`,
      ),
    ).toBe(`<at user_id="${AXEL}">AxelHu</at> 收到，就这次单独加，不写到 AGENTS.md 推广。`);
  });

  it("fixes </a> closing for id format (card style with quotes)", () => {
    expect(normalizeTextAtTagClosing(`<at id="${HUNTER}">网格员二号</a> 任务内容`)).toBe(
      `<at id="${HUNTER}">网格员二号</at> 任务内容`,
    );
  });

  it("fixes </a> closing for id format (card style without quotes)", () => {
    expect(normalizeTextAtTagClosing(`<at id=${HUNTER}>网格员二号</a> 任务内容`)).toBe(
      `<at id="${HUNTER}">网格员二号</at> 任务内容`,
    );
  });

  it("leaves correctly-closed </at> alone (idempotent)", () => {
    const correct = `<at user_id="${AXEL}">AxelHu</at> 收到`;
    expect(normalizeTextAtTagClosing(correct)).toBe(correct);
  });

  it("does not touch regular HTML <a> tags", () => {
    const html = '<a href="https://example.com">link</a>';
    expect(normalizeTextAtTagClosing(html)).toBe(html);
  });

  it("does not auto-close missing </at> (intentional, scope ambiguous)", () => {
    const broken = `<at user_id="${AXEL}">AxelHu 收到，后续内容`;
    expect(normalizeTextAtTagClosing(broken)).toBe(broken);
  });

  it("handles multiple broken at-tags in same message", () => {
    const input = `<at user_id="${AXEL}">AxelHu</a> 跟 <at user_id="${HUNTER}">网格员二号</a> 一起干活`;
    const expected = `<at user_id="${AXEL}">AxelHu</at> 跟 <at user_id="${HUNTER}">网格员二号</at> 一起干活`;
    expect(normalizeTextAtTagClosing(input)).toBe(expected);
  });

  it("does not touch at-tags with non-openid user_id (defensive)", () => {
    // user_id 不是 ou_ 前缀 → 不动（避免误改）
    const unknown = `<at user_id="not_an_openid">name</a>`;
    expect(normalizeTextAtTagClosing(unknown)).toBe(unknown);
  });
});

// Regression: 6/9 f179cb5d122 fixed </a> drift in plain text path.
// Card path was missed, so cards with `<at user_id="ou_xxx">name</a>`
// no-matched extractMentionTagsFromText, leaving malformed text that
// Feishu rejected with code 230099 "invalid user resource (at/person)".
// Caller must run normalizeTextAtTagClosing first (done in
// sendMarkdownCardFeishu / sendStructuredCardFeishu / streaming-card).
describe("card path </a> drift integration (regression for 230099)", () => {
  it("extractMentionTagsFromText alone does NOT match </a> drift (regression case)", () => {
    // Baseline: without the normalizeTextAtTagClosing pre-pass, the
    // extraction regex silently no-matches and returns no mentions.
    const drift = `<at user_id="${AXEL}">AxelHu</a> 黄金矿工：\n# 1. 主菜单进不去`;
    const result = extractMentionTagsFromText(drift);
    expect(result.mentions).toEqual([]);
    // And the malformed tag is preserved in text — this is the exact
    // failure mode that hit Feishu with 230099 on 6/10 15:12:24.
    expect(result.text).toContain("<at user_id=");
    expect(result.text).toContain("</a>");
  });

  it("normalizeTextAtTagClosing then extractMentionTagsFromText correctly extracts the mention", () => {
    // With the fix: caller runs normalizeTextAtTagClosing first, then
    // extraction works. The text no longer carries the malformed tag.
    const drift = `<at user_id="${AXEL}">AxelHu</a> 黄金矿工：\n# 1. 主菜单进不去`;
    const fixed = normalizeTextAtTagClosing(drift);
    const result = extractMentionTagsFromText(fixed);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].openId).toBe(AXEL);
    expect(result.mentions[0].name).toBe("AxelHu");
    expect(result.text).not.toContain("<at user_id=");
    expect(result.text).not.toContain("</a>");
    // @AxelHu placeholder should be in the text
    expect(result.text).toContain("@AxelHu");
  });

  it("idempotent: running normalizeTextAtTagClosing twice is a no-op (safe to call from multiple paths)", () => {
    const drift = `<at user_id="${AXEL}">AxelHu</a> 跟 <at id="${HUNTER}">网格员二号</a> 一起干活`;
    const once = normalizeTextAtTagClosing(drift);
    const twice = normalizeTextAtTagClosing(once);
    expect(twice).toBe(once);
  });
});
