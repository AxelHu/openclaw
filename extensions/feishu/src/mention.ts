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
/** Extract inline Feishu mention tags from model-authored card text. */
export function extractMentionTagsFromText(text: string): {
  text: string;
  mentions: MentionTarget[];
} {
  const mentions: MentionTarget[] = [];
  const seen = new Set<string>();
  const push = (openId: string, name: string) => {
    if (seen.has(openId)) {
      return;
    }
    seen.add(openId);
    mentions.push({ openId, name, key: `@_extracted_${mentions.length + 1}` });
  };
  let result = text.replace(
    /<at\s+user_id="(ou_[A-Za-z0-9_]+)"\s*>([^<]*)<\/at>/g,
    (_match, openId: string, name: string) => {
      const display = name.trim();
      push(openId, display);
      return display ? ` @${display} ` : " ";
    },
  );
  result = result.replace(
    /<at\s+id="?(ou_[A-Za-z0-9_]+)"?\s*>([^<]*)<\/at>/g,
    (_match, openId: string, name: string) => {
      const display = name.trim();
      push(openId, display);
      return display ? ` @${display} ` : " ";
    },
  );
  return { text: result.replace(/[^\S\n]+/g, " ").trim(), mentions };
}

/** Merge explicit mentions with mentions extracted from model-authored text. */
export function mergeMentionsWithExtracted(
  base: MentionTarget[] | undefined,
  extracted: MentionTarget[],
): MentionTarget[] | undefined {
  const result = base ? [...base] : [];
  const seen = new Set(result.map((mention) => mention.openId));
  for (const mention of extracted) {
    if (seen.has(mention.openId)) {
      continue;
    }
    seen.add(mention.openId);
    result.push(mention);
  }
  return result.length > 0 ? result : undefined;
}

/** Normalize complete post/card Feishu mention spans into lark_md card syntax. */
export function normalizeCardMentionTags(text: string): string {
  // Only rewrite complete mention spans. An unclosed `<at ...>` is ambiguous
  // user/model text and must stay literal so later escaping can make it safe.
  return text.replace(
    /<at\s+(?:user_id|id)=(?:"([^"]+)"|([^\s>]+))\s*>([^<]*)<\/at>/gi,
    (match, quotedId: string | undefined, bareId: string | undefined, label: string) => {
      const rawId = quotedId ?? bareId ?? "";
      const normalizedId = rawId.replace(/\\(?=[ou_])/g, "");
      if (!/^ou_[A-Za-z0-9_]+$/u.test(normalizedId)) {
        return match;
      }
      return `<at id=${normalizedId}>${label}</at>`;
    },
  );
}

/** Normalize the common LLM drift that closes a Feishu <at> tag with </a>. */
export function normalizeTextAtTagClosing(text: string): string {
  // If the message already contains a valid at-tag, leave mixed markup alone;
  // repairing one stray close can accidentally widen/nest another mention.
  if (/<at\b[^>]*>[\s\S]*?<\/at>/i.test(text)) {
    return text;
  }
  return text
    .replace(/<at\s+user_id="(ou_[A-Za-z0-9_]+)"\s*>([^<]*)<\/a>/g, '<at user_id="$1">$2</at>')
    .replace(/<at\s+id="?(ou_[A-Za-z0-9_]+)"?\s*>([^<]*)<\/a>/g, '<at id="$1">$2</at>');
}
