import { describe, expect, it } from "vitest";
import { parseFeishuMarkdown, type FeishuMarkdownNode } from "./markdown.js";
import { chunkFeishuCardMarkdown } from "./send.js";

function allTables(node: FeishuMarkdownNode): FeishuMarkdownNode[] {
  return [...(node.type === "table" ? [node] : []), ...(node.children ?? []).flatMap(allTables)];
}
const table = (index: number) =>
  `| Item ${index} | Result |\n| --- | --- |\n| value ${index} | ok |`;
const report = (count: number) => Array.from({ length: count }, (_, i) => table(i)).join("\n\n");

describe("Feishu Markdown card table budget", () => {
  it.each([4, 5, 6, 9, 12])(
    "keeps all %i short tables and caps each Markdown element at four",
    (count) => {
      const text = report(count);
      const chunks = chunkFeishuCardMarkdown({ text, limit: 4000 });
      expect(chunks).toHaveLength(Math.ceil(count / 4));
      expect(chunks.join("")).toBe(text);
      expect(chunks.map((chunk) => allTables(parseFeishuMarkdown(chunk)).length)).toEqual(
        Array.from({ length: Math.ceil(count / 4) }, (_, i) => Math.min(4, count - i * 4)),
      );
    },
  );

  it("does not count pipe text, escaped pipes, or fenced table examples as separate tables", () => {
    const text = `a | b\nc | d\n\n\`\`\`markdown\n${report(7)}\n\`\`\`\n\n${report(4)}`;
    expect(chunkFeishuCardMarkdown({ text, limit: 4000 })).toEqual([text]);
  });

  it("recognizes tables without outer pipes and with alignment or escaped cells", () => {
    const text = Array.from(
      { length: 6 },
      (_, i) => `Item ${i} | Result\n:--- | ---:\nx\\|y | ok`,
    ).join("\n\n");
    const chunks = chunkFeishuCardMarkdown({ text, limit: 4000 });
    expect(chunks.map((chunk) => allTables(parseFeishuMarkdown(chunk)).length)).toEqual([4, 2]);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves nested quote tables when breaking between complete tables", () => {
    const text = report(6)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const chunks = chunkFeishuCardMarkdown({ text, limit: 4000 });
    expect(chunks.map((chunk) => allTables(parseFeishuMarkdown(chunk)).length)).toEqual([4, 2]);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps list-contained tables as tables in continuation messages", () => {
    const text = `1. report\n\n${report(6)
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n")}`;
    const chunks = chunkFeishuCardMarkdown({ text, limit: 4000 });
    expect(chunks.map((chunk) => allTables(parseFeishuMarkdown(chunk)).length)).toEqual([4, 2]);
    expect(chunks[1]).toMatch(/^1\./);
    for (let i = 0; i < 6; i++) {
      expect(chunks.join("\n")).toContain(`value ${i}`);
    }
  });

  it("reopens a deeply indented list rather than turning remaining tables into code", () => {
    const text = `- outer\n  - inner\n\n${report(6)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}`;
    const chunks = chunkFeishuCardMarkdown({ text, limit: 4000 });
    expect(chunks.map((chunk) => allTables(parseFeishuMarkdown(chunk)).length)).toEqual([4, 2]);
  });

  it("reserves the card-wide five-table budget for tables in the note", () => {
    const chunks = chunkFeishuCardMarkdown({ text: report(6), note: report(2), limit: 4000 });
    expect(chunks.map((chunk) => allTables(parseFeishuMarkdown(chunk)).length)).toEqual([3, 3]);
  });

  it("rejects an oversized unsplittable repeated note before sending", () => {
    expect(() =>
      chunkFeishuCardMarkdown({ text: report(1), note: report(5), limit: 4000 }),
    ).toThrow(/note.*table/i);
  });

  it("handles precomputed initial chunks from the normal reply dispatcher", () => {
    const text = report(6);
    expect(chunkFeishuCardMarkdown({ text, initialChunks: [text], limit: 4000 })).toHaveLength(2);
  });

  it("keeps CRLF table boundaries and references resolvable in both messages", () => {
    const text =
      `${report(6).replaceAll("ok", "[docs][guide]")}\n\n[guide]: https://example.test/guide`.replaceAll(
        "\n",
        "\r\n",
      );
    const chunks = chunkFeishuCardMarkdown({ text, limit: 4000 });
    expect(chunks.map((chunk) => allTables(parseFeishuMarkdown(chunk)).length)).toEqual([4, 2]);
    for (const chunk of chunks) {
      expect(chunk).toContain("[guide]: https://example.test/guide");
      expect(chunk).toContain("[docs][guide]");
    }
    for (let i = 0; i < 6; i++) {
      expect(chunks.join("\n").match(new RegExp(`value ${i}`, "g"))).toHaveLength(1);
    }
  });

  it("still honors multibyte serialized-envelope limits and first/every-chunk mentions", () => {
    const text = `${report(6)}\n\n${"中文🙂".repeat(8000)}`;
    const chunks = chunkFeishuCardMarkdown({
      text,
      limit: 50000,
      header: { title: "标题".repeat(30) },
      note: "备注",
      firstChunkMentions: [{ openId: "ou_first", name: "甲" }],
      chunkMentions: [{ openId: "ou_bot", name: "乙" }],
    });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => allTables(parseFeishuMarkdown(chunk)).length <= 4)).toBe(true);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") < 30 * 1024)).toBe(true);
    expect(chunks.join("")).toContain("value 5");
    expect(chunks.join("").match(/中文🙂/g)).toHaveLength(8000);
  });
});
