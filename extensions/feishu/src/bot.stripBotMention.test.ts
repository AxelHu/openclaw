// Feishu tests cover bot.stripBotMention plugin behavior.
import { describe, expect, it } from "vitest";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

function makeEvent(
  text: string,
  mentions?: Array<{ key: string; name: string; id: { open_id?: string; user_id?: string } }>,
  chatType: "p2p" | "group" = "p2p",
): FeishuMessageEvent {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  };
}

const BOT_OPEN_ID = "ou_bot";

describe("normalizeMentions (via parseFeishuMessageEvent)", () => {
  it("returns original text when mentions are missing", () => {
    const ctx = parseFeishuMessageEvent(makeEvent("hello world", undefined), BOT_OPEN_ID);
    expect(ctx.content).toBe("hello world");
  });

  it("preserves bot's own mention in p2p (so the model sees who was addressed)", () => {
    // Bug fix (port of 4.27 commit f5ea371bd82): the botStripId branch that
    // stripped the receiving bot's own <at> caused NO_REPLY in multi-bot
    // groups. The mention tag is preserved in text content; mentionedBot flag
    // still captures whether the bot was addressed.
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hello", [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_bot">Bot</at> hello');
  });

  it("preserves bot's own mention in group (slash command stripping disabled)", () => {
    // See note above. The 5.28 design intended for botStripId to strip in
    // both p2p and group contexts (so /command parsing could detect the
    // leading slash), but the production code does not actually strip —
    // botStripId is passed through and ignored. This test documents the
    // actual behavior, which matches the 4.27 commit that removed the
    // strip entirely to fix multi-bot NO_REPLY.
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 hello",
        [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_bot">Bot</at> hello');
  });

  it("preserves bot's own mention in group even when text starts with slash", () => {
    // KNOWN LIMITATION: with botStripId removed (4.27 fix for NO_REPLY), the
    // receiving bot's mention is preserved in content text. Downstream
    // slash command parsing needs to handle "@Bot /model" (mentionedBot
    // flag + content contains /model after stripping the mention).
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 /model",
        [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_bot">Bot</at> /model');
  });

  it("preserves bot's own mention but normalizes other mentions in p2p", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 @_user_alice hello", [
        { key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } },
        { key: "@_user_alice", name: "Alice", id: { open_id: "ou_alice" } },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe(
      '<at user_id="ou_bot">Bot</at> <at user_id="ou_alice">Alice</at> hello',
    );
  });

  it("falls back to @name when open_id is absent", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ key: "@_user_1", name: "Alice", id: { user_id: "uid_alice" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Alice hi");
  });

  it("falls back to plain @name when no id is present", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_unknown hey", [{ key: "@_unknown", name: "Nobody", id: {} }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Nobody hey");
  });

  it("treats mention key regex metacharacters as literal text", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("hello world", [{ key: ".*", name: "Bot", id: { open_id: "ou_bot" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello world");
  });

  it("normalizes multiple mentions in one pass", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hi @_user_2", [
        { key: "@_bot_1", name: "Bot One", id: { open_id: "ou_bot_1" } },
        { key: "@_user_2", name: "User Two", id: { open_id: "ou_user_2" } },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe(
      '<at user_id="ou_bot_1">Bot One</at> hi <at user_id="ou_user_2">User Two</at>',
    );
  });

  it("treats $ in display name as literal (no replacement-pattern interpolation)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ key: "@_user_1", name: "$& the user", id: { open_id: "ou_x" } }]),
      BOT_OPEN_ID,
    );
    // $ is preserved literally (no $& pattern substitution); & is not escaped in tag body
    expect(ctx.content).toBe('<at user_id="ou_x">$& the user</at> hi');
  });

  it("escapes < and > in mention name to protect tag structure", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 test", [{ key: "@_user_1", name: "<script>", id: { open_id: "ou_x" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_x">&lt;script&gt;</at> test');
  });
});
