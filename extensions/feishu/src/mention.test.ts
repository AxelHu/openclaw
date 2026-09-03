import { describe, expect, it } from "vitest";
import {
  extractMentionTagsFromText,
  mergeMentionsWithExtracted,
  normalizeCardMentionTags,
  normalizeTextAtTagClosing,
} from "./mention.js";

describe("Feishu model-authored mention normalization", () => {
  it("repairs </a> drift when the message has no valid at-tag", () => {
    expect(normalizeTextAtTagClosing('<at user_id="ou_target">Target</a> hello')).toBe(
      '<at user_id="ou_target">Target</at> hello',
    );
  });

  it("leaves mixed valid and malformed mention markup untouched", () => {
    const text = '<at user_id="ou_one">One</at> <at user_id="ou_two">Two</a>';
    expect(normalizeTextAtTagClosing(text)).toBe(text);
  });

  it("extracts inline mentions while keeping a readable @name placeholder", () => {
    expect(extractMentionTagsFromText('<at user_id="ou_target">Target</at> hello')).toEqual({
      text: "@Target hello",
      mentions: [{ openId: "ou_target", name: "Target", key: "@_extracted_1" }],
    });
  });

  it("deduplicates extracted mentions against explicit targets", () => {
    expect(
      mergeMentionsWithExtracted(
        [{ openId: "ou_target", name: "Explicit", key: "@explicit" }],
        [
          { openId: "ou_target", name: "Inline", key: "@inline" },
          { openId: "ou_second", name: "Second", key: "@second" },
        ],
      ),
    ).toEqual([
      { openId: "ou_target", name: "Explicit", key: "@explicit" },
      { openId: "ou_second", name: "Second", key: "@second" },
    ]);
  });

  it("converts post-style mentions to lark_md card syntax", () => {
    expect(normalizeCardMentionTags('<at user_id="ou_target">Target</at>')).toBe(
      "<at id=ou_target>Target</at>",
    );
  });

  it("leaves incomplete mention openings literal", () => {
    expect(normalizeCardMentionTags('Choose <at id="ou_target">')).toBe(
      'Choose <at id="ou_target">',
    );
  });
});
