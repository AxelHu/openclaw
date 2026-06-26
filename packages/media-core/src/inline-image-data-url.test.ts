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

describe("inline video base64 sanitizer (6/26 PATCH)", () => {
  // MP4 / MOV ISO-BMFF ftyp box: bytes 4-7 = 'ftyp', bytes 8-11 = major brand
  // Reference brands: 'mp42', 'isom', 'avc1', 'qt  ' (QuickTime), 'M4V ' (iTunes)
  const MP4_MP42_HEADER = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
    0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const MP4_QT_HEADER = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x00,
    0x71, 0x74, 0x20, 0x20, 0x32, 0x30, 0x30, 0x35,
  ]);
  const WEBM_HEADER = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // EBML magic
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x42, 0x82]), // DocType element ID
    Buffer.from([0x04]),
    Buffer.from("webm", "ascii"),
  ]);
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const FAKE_MP4_BRAND = Buffer.from([
    0x00,
    0x00,
    0x00,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    0x66,
    0x61,
    0x6b,
    0x65, // brand 'fake' (not in whitelist)
    0x00,
    0x00,
    0x00,
    0x00,
    0x66,
    0x61,
    0x6b,
    0x65,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const buildBase64 = (header: Buffer): string =>
    Buffer.concat([header, Buffer.alloc(64, 0xab)]).toString("base64");

  it("accepts MP4 base64 with whitelisted brand (mp42)", () => {
    const result = sanitizeInlineVideoBase64({
      mimeType: "video/mp4",
      base64: buildBase64(MP4_MP42_HEADER),
    });
    expect(result).toEqual({ mimeType: "video/mp4", base64: buildBase64(MP4_MP42_HEADER) });
  });

  it("accepts QuickTime/MP4 base64 with 'qt  ' brand", () => {
    const result = sanitizeInlineVideoBase64({
      mimeType: "video/mp4",
      base64: buildBase64(MP4_QT_HEADER),
    });
    expect(result?.mimeType).toBe("video/mp4");
  });

  it("accepts WebM base64 with EBML magic + DocType=webm", () => {
    const result = sanitizeInlineVideoBase64({
      mimeType: "video/webm",
      base64: buildBase64(WEBM_HEADER),
    });
    expect(result?.mimeType).toBe("video/webm");
  });

  it("rejects MP4 base64 with non-whitelisted brand (impersonation guard)", () => {
    const result = sanitizeInlineVideoBase64({
      mimeType: "video/mp4",
      base64: buildBase64(FAKE_MP4_BRAND),
    });
    expect(result).toBeUndefined();
  });

  it("rejects PNG base64 mislabeled as video/mp4 (mime-impersonation guard)", () => {
    const result = sanitizeInlineVideoBase64({
      mimeType: "video/mp4",
      base64: buildBase64(PNG_HEADER),
    });
    expect(result).toBeUndefined();
  });

  it("rejects non-video mimeType even with valid MP4 base64", () => {
    const result = sanitizeInlineImageBase64({
      mimeType: "video/mp4",
      base64: buildBase64(MP4_MP42_HEADER),
    });
    expect(result).toBeUndefined();
  });

  it("rejects empty mimeType", () => {
    expect(
      sanitizeInlineVideoBase64({ mimeType: "", base64: buildBase64(MP4_MP42_HEADER) }),
    ).toBeUndefined();
  });

  it("rejects malformed base64 (non-canonical chars)", () => {
    expect(
      sanitizeInlineVideoBase64({ mimeType: "video/mp4", base64: "not_valid_base64!@#" }),
    ).toBeUndefined();
  });
});
