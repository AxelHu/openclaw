// Feishu-specific Markdown parsing and chunking.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { MentionTarget } from "./mention-target.types.js";

export type FeishuMarkdownNode = {
  type: string;
  depth?: number;
  identifier?: string;
  url?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: FeishuMarkdownNode[];
};

type FeishuPostMessageElement =
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "md"; text: string };

const FEISHU_POST_MAX_BYTES = 30 * 1024;

/** One parser contract for Feishu message and document Markdown decisions. */
export function parseFeishuMarkdown(text: string): FeishuMarkdownNode {
  return fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as FeishuMarkdownNode;
}

/** Count GFM table nodes, not pipe characters or fenced Markdown examples. */
export function countFeishuMarkdownTables(text: string): number {
  const pending = [parseFeishuMarkdown(text)];
  let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "table") {
      count += 1;
    }
    pending.push(...(node.children ?? []));
  }
  return count;
}

function splitFeishuMarkdownTables(text: string, maxTables?: number): string[] {
  if (maxTables === undefined) {
    return [text];
  }
  const tables: Array<{ end: number; lists: FeishuMarkdownNode[] }> = [];
  const definitions: string[] = [];
  let hasReferences = false;
  const visit = (node: FeishuMarkdownNode, lists: FeishuMarkdownNode[]): void => {
    const ancestors = node.type === "listItem" ? [...lists, node] : lists;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "table" && end !== undefined) {
      tables.push({ end, lists: ancestors });
    }
    if (node.type === "definition" && start !== undefined && end !== undefined) {
      definitions.push(text.slice(start, end));
    }
    if (node.type === "linkReference" || node.type === "imageReference") {
      hasReferences = true;
    }
    for (const child of node.children ?? []) {
      visit(child, ancestors);
    }
  };
  visit(parseFeishuMarkdown(text), []);
  if (tables.length <= maxTables) {
    return [text];
  }
  const chunks: string[] = [];
  let start = 0;
  let reopen = "";
  for (const [index, table] of tables.entries()) {
    if ((index + 1) % maxTables !== 0 || index === tables.length - 1) {
      continue;
    }
    chunks.push(reopen + text.slice(start, table.end));
    // Without reopening list containers, an indented continuation becomes
    // code instead of the remaining tables. Quote markers already remain in source.
    reopen = table.lists
      .filter((list) => (list.position?.end.offset ?? 0) > table.end)
      .map((list) => {
        const offset = list.position!.start.offset!;
        const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
        const marker = /^(?:[-+*]|\d+[.)])[\t ]+/.exec(text.slice(offset))?.[0] ?? "";
        return `${text.slice(lineStart, offset)}${marker.trimEnd()}\n`;
      })
      .join("");
    start = table.end;
  }
  chunks.push(reopen + text.slice(start));
  // Each independent message needs definitions for previously resolved links.
  return hasReferences
    ? chunks.map((chunk) => {
        const missing = definitions.filter((definition) => !chunk.includes(definition));
        return missing.length ? `${chunk}\n\n${missing.join("\n")}` : chunk;
      })
    : chunks;
}

function buildFeishuPostMentionElements(mentions?: MentionTarget[]): FeishuPostMessageElement[] {
  if (!mentions?.length) {
    return [];
  }

  const elements: FeishuPostMessageElement[] = [];
  for (const mention of mentions) {
    const userId = mention.openId.trim();
    if (!userId) {
      continue;
    }
    const userName = mention.name.trim();
    elements.push({
      tag: "at",
      user_id: userId,
      ...(userName ? { user_name: userName } : {}),
    });
  }
  return elements;
}

export function buildFeishuPostMessageContent(params: {
  messageText: string;
  mentions?: MentionTarget[];
}): string {
  const content: FeishuPostMessageElement[] = [
    ...buildFeishuPostMentionElements(params.mentions),
    {
      tag: "md",
      text: params.messageText,
    },
  ];
  return JSON.stringify({
    zh_cn: {
      content: [content],
    },
  });
}

export function assertFeishuPostWithinEnvelope(content: string, label: string): void {
  if (Buffer.byteLength(content, "utf8") > FEISHU_POST_MAX_BYTES) {
    throw new Error(`${label} exceeds the 30 KB rich-post API limit`);
  }
}

function collectSoftBreakOffsets(text: string): number[] {
  const root = parseFeishuMarkdown(text);
  const offsets: number[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.children) {
      pending.push(...node.children);
    }
    if (node.type !== "text") {
      continue;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    for (let offset = start; offset < end; offset += 1) {
      const char = text[offset];
      if (char === "\n") {
        if (text[offset - 1] !== "\r") {
          offsets.push(offset);
        }
        continue;
      }
      if (char === "\r") {
        offsets.push(offset);
        if (text[offset + 1] === "\n") {
          offset += 1;
        }
      }
    }
  }

  return offsets.toSorted((left, right) => left - right);
}

/**
 * Materialize CommonMark soft breaks for Feishu post `md` rendering.
 *
 * The parser identifies only soft breaks, then upgrades them to CommonMark
 * hard breaks. Structural line endings and code, HTML, definitions, setext
 * headings, and existing hard breaks retain their source bytes.
 */
export function materializeFeishuPostMarkdownSoftBreaks(text: string): string {
  if (!text.includes("\n") && !text.includes("\r")) {
    return text;
  }

  const softBreakOffsets = collectSoftBreakOffsets(text);
  if (softBreakOffsets.length === 0) {
    return text;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const offset of softBreakOffsets) {
    const lineEnding = text[offset] === "\r" ? (text[offset + 1] === "\n" ? "\r\n" : "\r") : "\n";
    parts.push(text.slice(cursor, offset), "  ", lineEnding);
    cursor = offset + lineEnding.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function chunkFeishuMarkdownWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  return chunkMarkdownTextWithMode(text, limit, mode);
}

/** Keep every platform chunk independently valid Markdown, including fences. */
export function chunkFeishuMarkdown(text: string, limit: number): string[] {
  return chunkFeishuMarkdownWithMode(text, limit, "length");
}

function postContentBytes(messageText: string, mentions?: MentionTarget[]): number {
  return Buffer.byteLength(buildFeishuPostMessageContent({ messageText, mentions }), "utf8");
}

/**
 * Honor both configured character chunking and Feishu's serialized post envelope.
 * Markdown wrappers and first-chunk mentions count toward the byte budget.
 */
export type FeishuMarkdownChunkOptions = {
  text: string;
  limit: number;
  mode?: ChunkMode;
  firstChunkMentions?: MentionTarget[];
  chunkMentions?: MentionTarget[];
  initialChunks?: string[];
};

export function chunkFeishuPostMarkdown(params: FeishuMarkdownChunkOptions): string[] {
  return chunkFeishuMarkdownByEnvelope({
    ...params,
    contentBytes: (text, isFirst) =>
      postContentBytes(text, [
        ...(params.chunkMentions ?? []),
        ...(isFirst ? (params.firstChunkMentions ?? []) : []),
      ]),
  });
}

/** Measure the actual transport envelope, including UTF-8, JSON escapes and fence wrappers. */
export function chunkFeishuMarkdownByEnvelope(
  params: FeishuMarkdownChunkOptions & {
    contentBytes: (text: string, isFirst: boolean) => number;
    maxTables?: number;
  },
): string[] {
  const { text } = params;
  if (!text) {
    return [];
  }

  const requestedLimit =
    Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : text.length;
  const initialChunks = (
    params.initialChunks ??
    chunkFeishuMarkdownWithMode(text, requestedLimit, params.mode ?? "length")
  ).flatMap((chunk) => splitFeishuMarkdownTables(chunk, params.maxTables));
  const output: string[] = [];
  for (const initialChunk of initialChunks) {
    if (params.contentBytes(initialChunk, output.length === 0) <= FEISHU_POST_MAX_BYTES) {
      output.push(initialChunk);
      continue;
    }

    let adaptiveLimit = Math.max(1, Math.min(requestedLimit, initialChunk.length));

    while (true) {
      const chunks = chunkFeishuMarkdownWithMode(
        initialChunk,
        adaptiveLimit,
        params.mode ?? "length",
      ).flatMap((chunk) => splitFeishuMarkdownTables(chunk, params.maxTables));
      let largestContentBytes = 0;
      let oversizedChunk: string | undefined;

      for (const [index, chunk] of chunks.entries()) {
        const contentBytes = params.contentBytes(chunk, output.length === 0 && index === 0);
        largestContentBytes = Math.max(largestContentBytes, contentBytes);
        if (contentBytes > FEISHU_POST_MAX_BYTES && oversizedChunk === undefined) {
          oversizedChunk = chunk;
        }
      }

      if (oversizedChunk === undefined) {
        output.push(...chunks);
        break;
      }
      if (adaptiveLimit === 1) {
        throw new Error("Feishu Markdown chunk exceeds the 30 KB API limit");
      }

      // Scale by the observed serialized size, then force progress for envelope
      // overhead or Markdown fence wrappers that do not shrink with source text.
      adaptiveLimit = Math.max(
        1,
        Math.min(
          adaptiveLimit - 1,
          Math.floor((adaptiveLimit * FEISHU_POST_MAX_BYTES) / largestContentBytes) - 1,
        ),
      );
    }
  }

  return output;
}
