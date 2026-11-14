/**
 * Node 22's Zstd decoder can end successfully after a truncated frame. Check
 * framing alongside it so partial rollout text cannot become a token snapshot.
 * The native decoder still validates compressed blocks and content checksums.
 * https://www.rfc-editor.org/rfc/rfc8878.html#section-3.1
 */
export class ZstdFrameValidator {
  private stage: "magic" | "descriptor" | "block" | "checksum" | "skip-size" = "magic";
  private readonly field = Buffer.allocUnsafe(4);
  private fieldBytes = 0;
  private skipBytes = 0;
  private checksum = false;
  private sawFrame = false;

  /** Return offsets just past complete frames, allowing one native decoder per frame. */
  push(chunk: Buffer): number[] {
    const frameEnds: number[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.skipBytes > 0) {
        const skipped = Math.min(this.skipBytes, chunk.length - offset);
        this.skipBytes -= skipped;
        offset += skipped;
        if (this.atBoundary()) {
          frameEnds.push(offset);
        }
        continue;
      }
      const fieldSize = this.stage === "descriptor" ? 1 : this.stage === "block" ? 3 : 4;
      const copied = Math.min(fieldSize - this.fieldBytes, chunk.length - offset);
      chunk.copy(this.field, this.fieldBytes, offset, offset + copied);
      this.fieldBytes += copied;
      offset += copied;
      if (this.fieldBytes !== fieldSize) {
        continue;
      }
      this.readField();
      this.fieldBytes = 0;
      if (this.atBoundary()) {
        frameEnds.push(offset);
      }
    }
    return frameEnds;
  }

  finish(): void {
    if (!this.sawFrame || !this.atBoundary()) {
      throw new Error("Incomplete Zstandard frame");
    }
  }

  private atBoundary(): boolean {
    return this.stage === "magic" && this.fieldBytes === 0 && this.skipBytes === 0;
  }

  private readField(): void {
    switch (this.stage) {
      case "magic": {
        const magic = this.field.readUInt32LE();
        if (magic === 0xfd2fb528) {
          this.stage = "descriptor";
        } else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
          this.stage = "skip-size";
        } else {
          throw new Error("Invalid Zstandard frame magic");
        }
        this.sawFrame = true;
        break;
      }
      case "descriptor": {
        const descriptor = this.field.readUInt8();
        if (descriptor & 0x08) {
          throw new Error("Reserved Zstandard frame descriptor bit");
        }
        const singleSegment = (descriptor & 0x20) !== 0;
        const sizeFlag = descriptor >>> 6;
        const contentSizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 ** sizeFlag;
        const dictionaryFlag = descriptor & 0x03;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        this.skipBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        this.checksum = (descriptor & 0x04) !== 0;
        this.stage = "block";
        break;
      }
      case "block": {
        const header = this.field.readUIntLE(0, 3);
        const blockType = (header >>> 1) & 0x03;
        if (blockType === 3) {
          throw new Error("Reserved Zstandard block type");
        }
        // RLE stores one byte even when its regenerated block is much larger.
        this.skipBytes = blockType === 1 ? 1 : header >>> 3;
        const lastBlock = (header & 1) !== 0;
        this.stage = lastBlock ? (this.checksum ? "checksum" : "magic") : "block";
        break;
      }
      case "checksum":
        this.stage = "magic";
        break;
      case "skip-size":
        this.skipBytes = this.field.readUInt32LE();
        this.stage = "magic";
        break;
    }
  }
}
