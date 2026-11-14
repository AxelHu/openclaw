import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { ZstdFrameValidator } from "./zstd-framing.js";

const JSONL_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;
export const JSONL_FIRST_LINE_CHUNK_BYTES = 64 * 1024;

export function isJsonlFile(file: string): boolean {
  return file.endsWith(".jsonl") || file.endsWith(".jsonl.zst");
}

/** The native reader prefers a materialized rollout over its compressed sibling. */
export function plainJsonlFile(file: string): string {
  return file.endsWith(".jsonl.zst") ? file.slice(0, -4) : file;
}

export async function visitJsonlLines(
  file: string,
  visitor: (line: string) => boolean | void,
  chunkBytes = JSONL_READ_CHUNK_BYTES,
): Promise<{ ok: boolean; lineCount: number }> {
  if (file.endsWith(".jsonl.zst")) {
    const { ok, lineCount } = await visitCompressedJsonlLines(file, visitor, { chunkBytes });
    return { ok, lineCount };
  }
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { ok: false, lineCount: 0 };
  }
  if (size <= JSONL_STREAM_THRESHOLD_BYTES) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      return { ok: false, lineCount: 0 };
    }
    if (content.length === 0) {
      return { ok: true, lineCount: 0 };
    }
    let lineCount = 0;
    for (const line of content.split(/\r?\n/u)) {
      lineCount += 1;
      if (visitor(line) === false) {
        break;
      }
    }
    return { ok: true, lineCount };
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return { ok: false, lineCount: 0 };
  }
  try {
    const { lineCount } = await visitJsonlChunks(readFileChunks(handle, chunkBytes), visitor);
    return { ok: true, lineCount };
  } catch {
    return { ok: false, lineCount: 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Reads without materializing history on disk, and closes the supplied pinned descriptor. */
export async function visitCompressedJsonlLines(
  file: string,
  visitor: (line: string) => boolean | void,
  options: {
    handle?: Awaited<ReturnType<typeof fs.open>>;
    chunkBytes?: number;
    maxBytes?: number;
  } = {},
): Promise<{ ok: boolean; lineCount: number; bytes: number }> {
  let handle = options.handle;
  if (!handle) {
    try {
      handle = await fs.open(file, "r");
    } catch {
      return { ok: false, lineCount: 0, bytes: 0 };
    }
  }
  const chunkBytes = options.chunkBytes ?? JSONL_READ_CHUNK_BYTES;
  try {
    const { lineCount, bytes } = await visitJsonlChunks(
      decodeCompressedFileChunks(handle, chunkBytes),
      visitor,
      options.maxBytes,
    );
    return { ok: true, lineCount, bytes };
  } catch {
    return { ok: false, lineCount: 0, bytes: 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type CompressedFrameChunk = { data: Buffer; endsFrame: boolean };

async function* readCompressedFileFrames(
  handle: Awaited<ReturnType<typeof fs.open>>,
  chunkBytes: number,
): AsyncGenerator<CompressedFrameChunk> {
  const frames = new ZstdFrameValidator();
  for await (const chunk of readFileChunks(handle, chunkBytes)) {
    let offset = 0;
    for (const end of frames.push(chunk)) {
      yield { data: chunk.subarray(offset, end), endsFrame: true };
      offset = end;
    }
    if (offset < chunk.length) {
      yield { data: chunk.subarray(offset), endsFrame: false };
    }
  }
  // An intentional first-line or byte-limit stop closes this generator before
  // EOF. Full scans must finish a frame, including its optional checksum.
  frames.finish();
}

async function* decodeCompressedFileChunks(
  handle: Awaited<ReturnType<typeof fs.open>>,
  chunkBytes: number,
): AsyncGenerator<Buffer> {
  const frames = readCompressedFileFrames(handle, chunkBytes);
  try {
    let next = await frames.next();
    while (!next.done) {
      // Node 22 otherwise silently decodes only the first concatenated frame.
      const input = Readable.from(readOneCompressedFrame(frames, next.value));
      const decoded = createZstdDecompress({ chunkSize: chunkBytes });
      const completed = pipeline(input, decoded);
      void completed.catch(() => undefined);
      try {
        for await (const chunk of decoded) {
          yield chunk as Buffer;
        }
        await completed;
      } finally {
        input.destroy();
        decoded.destroy();
        await completed.catch(() => undefined);
      }
      next = await frames.next();
    }
  } finally {
    await frames.return(undefined);
  }
}

async function* readOneCompressedFrame(
  frames: AsyncGenerator<CompressedFrameChunk>,
  first: CompressedFrameChunk,
): AsyncGenerator<Buffer> {
  let chunk = first;
  while (true) {
    yield chunk.data;
    if (chunk.endsFrame) {
      return;
    }
    const next = await frames.next();
    if (next.done) {
      return;
    }
    chunk = next.value;
  }
}

async function* readFileChunks(
  handle: Awaited<ReturnType<typeof fs.open>>,
  chunkBytes: number,
): AsyncGenerator<Buffer> {
  while (true) {
    // The decoder can retain a chunk while the source prefetches its successor.
    const buffer = Buffer.allocUnsafe(chunkBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      return;
    }
    yield buffer.subarray(0, bytesRead);
  }
}

async function visitJsonlChunks(
  chunks: AsyncIterable<Buffer>,
  visitor: (line: string) => boolean | void,
  maxBytes?: number,
): Promise<{ lineCount: number; bytes: number; stoppedEarly: boolean }> {
  const decoder = new TextDecoder();
  let pendingFragments: string[] = [];
  let lineCount = 0;
  let bytes = 0;
  for await (const chunk of chunks) {
    bytes += chunk.length;
    if (maxBytes !== undefined && bytes >= maxBytes) {
      return { lineCount, bytes, stoppedEarly: true };
    }
    const content = decoder.decode(chunk, { stream: true });
    let lineStart = 0;
    while (true) {
      const newline = content.indexOf("\n", lineStart);
      if (newline === -1) {
        break;
      }
      let rawLine = content.slice(lineStart, newline);
      if (pendingFragments.length > 0) {
        pendingFragments.push(rawLine);
        rawLine = pendingFragments.join("");
        pendingFragments = [];
      }
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      lineCount += 1;
      if (visitor(line) === false) {
        return { lineCount, bytes, stoppedEarly: true };
      }
      lineStart = newline + 1;
    }
    if (lineStart < content.length) {
      pendingFragments.push(content.slice(lineStart));
    }
  }
  const decoderTail = decoder.decode();
  if (decoderTail.length > 0) {
    pendingFragments.push(decoderTail);
  }
  if (pendingFragments.length > 0) {
    const rawLine = pendingFragments.join("");
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    lineCount += 1;
    visitor(line);
  }
  return { lineCount, bytes, stoppedEarly: false };
}
