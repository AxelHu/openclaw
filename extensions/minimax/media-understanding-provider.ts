// Minimax provider module implements model/runtime integration.
import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
  type VideoUploadRequest,
  type VideoUploadResult,
} from "openclaw/plugin-sdk/media-understanding";
import { uploadMinimaxFile } from "./files-api.js";

/**
 * 6/25 PATCH: implements `uploadVideo` so OpenClaw can route oversized
 * inbound video attachments through the minimax Files API and reference
 * them as `mm_file://{file_id}` in downstream `type: "video"` blocks.
 */
async function uploadVideoMinimax(req: VideoUploadRequest): Promise<VideoUploadResult> {
  if (!req.cfg) {
    throw new Error(
      "MiniMax video upload requires OpenClaw config (cfg) to resolve baseUrl + apiKey",
    );
  }
  const upload = await uploadMinimaxFile({
    providerId: "minimax",
    cfg: req.cfg,
    buffer: req.buffer,
    mimeType: req.mimeType,
    fileName: req.fileName,
    purpose:
      (req.purpose as Parameters<typeof uploadMinimaxFile>[0]["purpose"]) ?? "video_understanding",
  });
  return {
    url: `mm_file://${upload.file_id}`,
    fileId: upload.file_id,
    bytes: upload.bytes,
    filename: upload.filename,
  };
}

export const minimaxMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax",
  capabilities: ["image", "video"],
  defaultModels: { image: "MiniMax-VL-01" },
  documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
  autoPriority: { image: 40 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  uploadVideo: uploadVideoMinimax,
};

export const minimaxPortalMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax-portal",
  capabilities: ["image", "video"],
  defaultModels: { image: "MiniMax-VL-01" },
  documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
  autoPriority: { image: 50 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  uploadVideo: uploadVideoMinimax,
};
