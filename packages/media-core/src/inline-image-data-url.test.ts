// Media Core tests cover inline image data url behavior.
import { describe, expect, it } from "vitest";
import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrl,
  sanitizeInlineImageDataUrlForStorage,
  sanitizeInlineVideoBase64,
  sniffInlineImageMime,
} from "./inline-image-data-url.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const BMP_HEADER = Buffer.from("BMfixture", "ascii").toString("base64");
const HEIC_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x69, 0x66, 0x31,
]).toString("base64");
const HEIF_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
]).toString("base64");

describe("inline image data URL sanitizer", () => {
  it("keeps non-data image references unchanged", () => {
    expect(sanitizeInlineImageDataUrl("https://example.test/image.png")).toBe(
      "https://example.test/image.png",
    );
  });

  it("rejects malformed and non-image data URLs", () => {
    expect(sanitizeInlineImageDataUrl("data:image/png;base64")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:text/plain;base64,SGVsbG8=")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:image/png,SGVsbG8=")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:image/png;base64,not base64!")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:image/png;base64,SGVsbG8=")).toBeUndefined();
  });

  it("canonicalizes valid data URLs with sniffed MIME type", () => {
    expect(sanitizeInlineImageDataUrl(`data:image/jpeg;base64,\n${PNG_1X1}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
  });

  it("canonicalizes valid unpadded image data URLs", () => {
    const unpaddedPng = PNG_1X1.replace(/=+$/u, "");
    expect(sanitizeInlineImageDataUrl(`data:image/png;base64,${unpaddedPng}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
  });

  it("rejects image data URLs for formats that require conversion before provider transport", () => {
    expect(sanitizeInlineImageDataUrl(`data:image/bmp;base64,${BMP_HEADER}`)).toBeUndefined();
    expect(sanitizeInlineImageDataUrl(`data:image/heic;base64,${HEIC_HEADER}`)).toBeUndefined();
    expect(sanitizeInlineImageDataUrl(`data:image/heif;base64,${HEIF_HEADER}`)).toBeUndefined();
  });

  it("canonicalizes valid image data URLs for storage without transport allowlist filtering", () => {
    expect(sanitizeInlineImageDataUrlForStorage(`data:image/bmp;base64,${BMP_HEADER}`)).toBe(
      `data:image/bmp;base64,${BMP_HEADER}`,
    );
    expect(sanitizeInlineImageDataUrlForStorage(`data:image/heic;base64,${HEIC_HEADER}`)).toBe(
      `data:image/heic;base64,${HEIC_HEADER}`,
    );
  });

  it("canonicalizes valid image base64 with sniffed MIME type", () => {
    expect(sanitizeInlineImageBase64({ mimeType: "image/jpeg", base64: `\n${PNG_1X1}` })).toEqual({
      mimeType: "image/png",
      base64: PNG_1X1,
    });
    expect(
      sanitizeInlineImageBase64({ mimeType: "image/png", base64: "SGVsbG8=" }),
    ).toBeUndefined();
  });

  it("accepts supported non-browser image signatures", () => {
    expect(sanitizeInlineImageBase64({ mimeType: "image/bmp", base64: BMP_HEADER })).toEqual({
      mimeType: "image/bmp",
      base64: BMP_HEADER,
    });
    expect(sanitizeInlineImageBase64({ mimeType: "image/heic", base64: HEIC_HEADER })).toEqual({
      mimeType: "image/heic",
      base64: HEIC_HEADER,
    });
    expect(sanitizeInlineImageBase64({ mimeType: "image/heif", base64: HEIF_HEADER })).toEqual({
      mimeType: "image/heif",
      base64: HEIF_HEADER,
    });
  });

  it("sniffs supported inline image signatures", () => {
    expect(sniffInlineImageMime(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
    expect(sniffInlineImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });
});

describe("inline video base64 sanitizer", () => {
  const MP4_MP42_HEADER = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
    0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const MP4_QT_HEADER = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x00,
    0x71, 0x74, 0x20, 0x20, 0x32, 0x30, 0x30, 0x35,
  ]);
  const WEBM_HEADER = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x42, 0x82]),
    Buffer.from([0x04]),
    Buffer.from("webm", "ascii"),
  ]);
  const MATROSKA_HEADER = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x42, 0x82, 0x08]),
    Buffer.from("matroska", "ascii"),
  ]);
  const AVI_HEADER = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x40, 0x00, 0x00, 0x00]),
    Buffer.from("AVI ", "ascii"),
  ]);
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const FAKE_MP4_BRAND = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x66, 0x61, 0x6b, 0x65, 0x00, 0x00, 0x00, 0x00,
    0x66, 0x61, 0x6b, 0x65, 0x00, 0x00, 0x00, 0x00,
  ]);
  const buildBase64 = (header: Buffer): string =>
    Buffer.concat([header, Buffer.alloc(64, 0xab)]).toString("base64");

  it("accepts MP4 base64 with a supported brand", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "video/mp4",
        base64: buildBase64(MP4_MP42_HEADER),
      }),
    ).toEqual({ mimeType: "video/mp4", base64: buildBase64(MP4_MP42_HEADER) });
  });

  it("accepts QuickTime-compatible ISO-BMFF base64", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "video/quicktime",
        base64: buildBase64(MP4_QT_HEADER),
      }),
    ).toEqual({ mimeType: "video/mp4", base64: buildBase64(MP4_QT_HEADER) });
  });

  it("accepts WebM base64 with EBML magic and a webm document type", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "video/webm",
        base64: buildBase64(WEBM_HEADER),
      }),
    ).toEqual({ mimeType: "video/webm", base64: buildBase64(WEBM_HEADER) });
  });

  it("accepts Matroska base64 with EBML magic and a matroska document type", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "video/x-matroska",
        base64: buildBase64(MATROSKA_HEADER),
      }),
    ).toEqual({ mimeType: "video/x-matroska", base64: buildBase64(MATROSKA_HEADER) });
  });

  it("accepts AVI base64 with a RIFF AVI signature", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "video/x-msvideo",
        base64: buildBase64(AVI_HEADER),
      }),
    ).toEqual({ mimeType: "video/x-msvideo", base64: buildBase64(AVI_HEADER) });
  });

  it("rejects an unsupported ISO-BMFF brand", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "video/mp4",
        base64: buildBase64(FAKE_MP4_BRAND),
      }),
    ).toBeUndefined();
  });

  it("rejects image bytes mislabeled as video", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "video/mp4",
        base64: buildBase64(PNG_HEADER),
      }),
    ).toBeUndefined();
  });

  it("rejects a non-video MIME type", () => {
    expect(
      sanitizeInlineVideoBase64({
        mimeType: "image/png",
        base64: buildBase64(MP4_MP42_HEADER),
      }),
    ).toBeUndefined();
  });

  it("rejects an empty MIME type", () => {
    expect(
      sanitizeInlineVideoBase64({ mimeType: "", base64: buildBase64(MP4_MP42_HEADER) }),
    ).toBeUndefined();
  });

  it("rejects malformed base64", () => {
    expect(
      sanitizeInlineVideoBase64({ mimeType: "video/mp4", base64: "not_valid_base64!@#" }),
    ).toBeUndefined();
  });
});
