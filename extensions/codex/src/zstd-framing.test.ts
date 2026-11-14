import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ZstdFrameValidator } from "./zstd-framing.js";

const checksummed = zstdCompressSync(Buffer.from("compressed 中文\n"), {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
});
// RFC 8878: a raw block with unknown content size, and a single-segment RLE
// block. Native decoding confirms that these independently authored frames work.
const raw = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x19, 0, 0, 0x61, 0x62, 0x63]);
const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 0x1b, 0, 0, 0x78]);
const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);

describe("Zstandard rollout framing", () => {
  it.each([1, 2, 7, 64])("accepts concatenated frames across %i-byte chunks", (chunkBytes) => {
    const encoded = Buffer.concat([checksummed, skippable, raw, rle]);
    expect(zstdDecompressSync(raw).toString()).toBe("abc");
    expect(zstdDecompressSync(rle).toString()).toBe("xxx");
    const frames = new ZstdFrameValidator();
    for (let offset = 0; offset < encoded.length; offset += chunkBytes) {
      frames.push(encoded.subarray(offset, offset + chunkBytes));
    }
    expect(() => frames.finish()).not.toThrow();
  });

  it.each([checksummed, raw, rle, skippable])(
    "rejects every truncated prefix of a frame",
    (frame) => {
      for (let end = 0; end < frame.length; end += 1) {
        const frames = new ZstdFrameValidator();
        frames.push(frame.subarray(0, end));
        expect(() => frames.finish(), `truncated at byte ${end}`).toThrow(
          "Incomplete Zstandard frame",
        );
      }
    },
  );

  it("rejects invalid magic and reserved framing values", () => {
    for (const encoded of [
      Buffer.from("invalid magic"),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x08]),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 7, 0, 0]),
    ]) {
      expect(() => new ZstdFrameValidator().push(encoded)).toThrow();
    }
  });
});
