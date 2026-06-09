import { describe, expect, it } from "vitest";
import { normalizeTextAtTagClosing } from "./mention.js";

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
