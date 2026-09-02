// Minimax provider module implements model/runtime integration.
import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { uploadMinimaxFile } from "./files-api.js";

type MinimaxUploadVideo = NonNullable<MediaUnderstandingProvider["uploadVideo"]>;

function createUploadVideo(providerId: "minimax" | "minimax-portal"): MinimaxUploadVideo {
  return async (req) => {
    const requestProviderId = req.provider.trim() || providerId;
    const result = await uploadMinimaxFile({
      providerId: requestProviderId,
      cfg: req.cfg,
      ...(req.agentDir ? { agentDir: req.agentDir } : {}),
      ...(req.authStore ? { authStore: req.authStore } : {}),
      buffer: req.buffer,
      mimeType: req.mimeType,
      ...(req.fileName ? { fileName: req.fileName } : {}),
      purpose: req.purpose,
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    return {
      url: `mm_file://${result.fileId}`,
      fileId: result.fileId,
      ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
      ...(result.fileName ? { fileName: result.fileName } : {}),
    };
  };
}

export const minimaxMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax",
  // `video` means transcript pre-processing via describeVideo. Hosted native
  // model input is exposed separately through uploadVideo.
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
  autoPriority: { image: 40 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  uploadVideo: createUploadVideo("minimax"),
};

export const minimaxPortalMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax-portal",
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
  autoPriority: { image: 50 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  uploadVideo: createUploadVideo("minimax-portal"),
};
