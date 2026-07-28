// Feishu plugin module implements mention behavior.
import type { FeishuMessageEvent } from "./event-types.js";
import type { MentionTarget } from "./mention-target.types.js";
import { isFeishuGroupChatType } from "./types.js";

type FeishuMentionLike = {
  key?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name?: string;
};

export function isFeishuBroadcastMention(mention: FeishuMentionLike): boolean {
  const normalizedKey = mention.key?.trim().toLowerCase();
  if (normalizedKey === "@all" || normalizedKey === "@_all") {
    return true;
  }

  const mentionIds = [mention.id?.open_id, mention.id?.user_id, mention.id?.union_id];
  return mentionIds.some((id) => id?.trim().toLowerCase() === "all");
}

/**
 * Extract mention targets from message event (excluding the bot itself)
 */
export function extractMentionTargets(
  event: FeishuMessageEvent,
  botOpenId: string,
): MentionTarget[] {
  const mentions = event.message.mentions ?? [];

  return mentions
    .filter((m) => {
      if (isFeishuBroadcastMention(m)) {
        return false;
      }
      // Exclude the bot itself
      if (m.id.open_id === botOpenId) {
        return false;
      }
      // Must have open_id
      return Boolean(m.id.open_id);
    })
    .map((m) => ({
      openId: m.id.open_id!,
      name: m.name,
      key: m.key,
    }));
}

/**
 * Check if message is a mention forward request
 * Rules:
 * - Group: message mentions bot + at least one other user
 * - DM: message mentions any user (no need to mention bot)
 */
export function isMentionForwardRequest(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) {
    return false;
  }
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return false;
  }

  const isDirectMessage = !isFeishuGroupChatType(event.message.chat_type);
  const userMentions = mentions.filter((m) => !isFeishuBroadcastMention(m));
  const hasOtherMention = userMentions.some((m) => m.id.open_id !== normalizedBotOpenId);

  if (isDirectMessage) {
    // DM: trigger if any non-bot user is mentioned
    return hasOtherMention;
  }
  // Group: need to mention both bot and other users
  const hasBotMention = userMentions.some((m) => m.id.open_id === normalizedBotOpenId);
  return hasBotMention && hasOtherMention;
}

/**
 * Format @mention for card message (lark_md)
 */
function formatMentionForCard(target: MentionTarget): string {
  return `<at id=${target.openId}></at>`;
}

/**
 * Build card content with @mentions (Markdown format)
 */
export function buildMentionedCardContent(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((t) => formatMentionForCard(t));
  return `${mentionParts.join(" ")} ${message}`;
}

/**
 * Extract <at user_id="...">name</at> or <at id="...">name</at> tags
 * already present in text. The card send path uses this to capture
 * openIds that the programmer wrote inline, so the recipient actually
 * receives a mention notification (the tag itself is replaced with a
 * plain "@name" placeholder; the openId is returned for the caller to
 * add to the card's `mentions` list).
 */
export function extractMentionTagsFromText(text: string): {
  text: string;
  mentions: MentionTarget[];
} {
  const mentions: MentionTarget[] = [];
  const seen = new Set<string>();

  const push = (openId: string, name: string) => {
    if (seen.has(openId)) return;
    seen.add(openId);
    mentions.push({ openId, name, key: `@_extracted_${mentions.length + 1}` });
  };

  // Match <at user_id="ou_xxx">name</at> (post text format)
  let result = text.replace(
    /<at\s+user_id="(ou_[A-Za-z0-9_]+)"\s*>([^<]*)<\/at>/g,
    (_, openId: string, name: string) => {
      push(openId, name.trim());
      const display = name.trim();
      return display ? ` @${display} ` : " ";
    },
  );

  // Match <at id="ou_xxx">name</at> or <at id=ou_xxx>name</at> (card format)
  result = result.replace(
    /<at\s+id="?(ou_[A-Za-z0-9_]+)"?\s*>([^<]*)<\/at>/g,
    (_, openId: string, name: string) => {
      push(openId, name.trim());
      const display = name.trim();
      return display ? ` @${display} ` : " ";
    },
  );

  // Collapse runs of horizontal whitespace left behind by the <at>
  // replacement, but preserve newlines so code blocks, tables, lists,
  // and paragraph breaks stay intact in the card body.
  return { text: result.replace(/[^\S\n]+/g, " ").trim(), mentions };
}

/**
 * Merge a base mentions list with extra mentions extracted from text.
 * Base mentions win on openId collision (parameter is more authoritative
 * than whatever the programmer wrote in text). Returns undefined when
 * the result is empty so callers can keep their existing `undefined`
 * semantics for "no mentions".
 */
export function mergeMentionsWithExtracted(
  base: MentionTarget[] | undefined,
  extracted: MentionTarget[],
): MentionTarget[] | undefined {
  const result: MentionTarget[] = base ? [...base] : [];
  const seen = new Set(result.map((m) => m.openId));
  for (const m of extracted) {
    if (seen.has(m.openId)) continue;
    seen.add(m.openId);
    result.push(m);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Normalize @mention tags for card lark_md format (used by both
 * interactive cards and streaming cards). The card renderer only
 * recognizes `<at id=open_id>name</at>` — not the post-text format
 * `<at user_id="open_id">name</at>` that LLMs commonly emit. This:
 *   1. Rewrites `<at user_id=` to `<at id=` (post → card attribute)
 *   2. Strips the surrounding quotes around the openId
 *   3. Drops any backslash escapes the model might have added
 *      before `o`, `u`, or `_` (e.g. `ou\_xxx` → `ou_xxx`)
 */
export function normalizeCardMentionTags(text: string): string {
  return text
    .replace(/<at user_id=/g, "<at id=")
    .replace(/<at id="([^"]+)">/g, "<at id=$1>")
    .replace(/\\(?=[ou_])/g, "");
}

/**
 * Normalize broken at-tag closing for the plain text send path.
 * LLMs sometimes close at-tags with `</a>` (HTML-ish drift from training
 * data) or omit the closing tag entirely. This function only fixes the
 * high-frequency `</a>` → `</at>` drift. We intentionally do NOT
 * auto-close missing `</at>` because the tag scope is ambiguous (could
 * be 1 char or 1000 chars); the safest fallback is to leave the unclosed
 * tag and let downstream extractors no-match gracefully (text still
 * renders readably, just without the blue mention chip).
 *
 * Targeted patterns:
 *   `<at user_id="ou_xxx">name</a>`  →  `<at user_id="ou_xxx">name</at>`
 *   `<at id=ou_xxx>name</a>`         →  `<at id=ou_xxx>name</at>`
 *
 * Card path uses `normalizeCardMentionTags` (separate function, called
 * from sendMarkdownCardFeishu / sendStructuredCardFeishu / streaming-card).
 * This function is only called from `sendMessageFeishu` (plain text path).
 */
export function normalizeTextAtTagClosing(text: string): string {
  // Conservative fix: only fix `</a>` drift when the text contains
  // NO correctly-closed `<at ...>...</at>` spans.
  //
  // If any correct close exists, the LLM has already expressed at least
  // one valid mention — fixing stray drift elsewhere in the same text
  // can interact with the existing mentions in unexpected ways (e.g.
  // producing `<at ...>...</at></at>` after a greedy match consumes the
  // intervening `</at>`, which Feishu rejects with 230099). Leaving
  // stray drift alone lets Feishu fall back to rendering the broken
  // tag as literal text, which is harmless.
  if (/<at\b[^>]*>[\s\S]*?<\/at>/i.test(text)) {
    return text;
  }
  return text
    .replace(/<at\s+user_id="(ou_[A-Za-z0-9_]+)"\s*>([^<]*)<\/a>/g, '<at user_id="$1">$2</at>')
    .replace(/<at\s+id="?(ou_[A-Za-z0-9_]+)"?\s*>([^<]*)<\/a>/g, '<at id="$1">$2</at>');
}
