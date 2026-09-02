import { normalizeMimeType } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import type {
  ModelInputContent,
  ProviderContext,
} from "../../../../packages/ai/src/provider-types.js";
import type { ImageContent, TextContent } from "../../../llm/types.js";
import { isImageMediaFact, isVideoMediaFact, type MediaFact } from "../../../media/media-facts.js";
import { readToolResultMediaFacts } from "../../../media/tool-result-media-facts.js";
import type { WebMediaResult } from "../../../media/web-media.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { ImageFactIndex } from "./prompt-image-metadata.js";

const PROVIDER_VIDEO_OMISSION = {
  unsupported: "(video omitted: provider does not support native video)",
  unavailable: "(video omitted: source unavailable)",
  invalid: "(video omitted: invalid video MIME type)",
  limit: "(video omitted: native video byte limit exceeded)",
} as const;

export type ProviderVideoProjectionOptions = {
  provider?: boolean;
  providerId?: string;
  signal?: AbortSignal;
  loadVideo: (fact: MediaFact, maxBytes: number) => Promise<WebMediaResult | null>;
};

function isOpaqueProviderMediaReference(value: string | undefined): value is string {
  const normalized = value?.trim();
  if (!normalized || !/^[a-z][a-z0-9+.-]*:\/\/\S+$/iu.test(normalized)) {
    return false;
  }
  return !hasHttpUrlPrefix(normalized) && !/^(?:data|file|media):/iu.test(normalized);
}

async function materializeProviderVideoFact(
  fact: MediaFact,
  budget: { remaining: number },
  options: ProviderVideoProjectionOptions,
): Promise<ModelInputContent> {
  options.signal?.throwIfAborted();
  const mimeType = normalizeMimeType(fact.contentType);
  if (fact.providerReference) {
    const reference = fact.url?.trim();
    const referenceProvider = fact.providerReference.trim().toLowerCase();
    const activeProvider = options.providerId?.trim().toLowerCase();
    return isOpaqueProviderMediaReference(reference) &&
      activeProvider === referenceProvider &&
      mimeType?.startsWith("video/")
      ? { type: "video", data: reference, mimeType, source: "url" }
      : { type: "text", text: PROVIDER_VIDEO_OMISSION.unsupported };
  }
  if ((fact.sizeBytes ?? 0) > budget.remaining) {
    return { type: "text", text: PROVIDER_VIDEO_OMISSION.limit };
  }
  const loaded = await options.loadVideo(fact, budget.remaining);
  options.signal?.throwIfAborted();
  if (!loaded) {
    return { type: "text", text: PROVIDER_VIDEO_OMISSION.unavailable };
  }
  const loadedMimeType = normalizeMimeType(loaded.contentType);
  if (loaded.kind !== "video" || !loadedMimeType?.startsWith("video/")) {
    return { type: "text", text: PROVIDER_VIDEO_OMISSION.invalid };
  }
  if (loaded.buffer.length > budget.remaining) {
    return { type: "text", text: PROVIDER_VIDEO_OMISSION.limit };
  }
  budget.remaining -= loaded.buffer.length;
  return { type: "video", data: loaded.buffer.toString("base64"), mimeType: loadedMimeType };
}

export async function projectOrderedProviderMedia(params: {
  content: Array<TextContent | ImageContent>;
  media: MediaFact[];
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  options: ProviderVideoProjectionOptions;
  budget: { remaining: number };
}): Promise<ModelInputContent[]> {
  const generatedMarkers = new Set<string>(Object.values(PROVIDER_VIDEO_OMISSION));
  const projected: ModelInputContent[] = params.content.filter(
    (block): block is TextContent => block.type === "text" && !generatedMarkers.has(block.text),
  );
  if (!params.media.some(isVideoMediaFact)) {
    return [...projected, ...params.images];
  }
  const imagesByFact = new Map<number, ImageContent[]>();
  const factlessImages: ImageContent[] = [];
  params.images.forEach((image, index) => {
    const factIndex = params.imageFactIndexes[index];
    if (factIndex == null) {
      factlessImages.push(image);
    } else {
      imagesByFact.set(factIndex, [...(imagesByFact.get(factIndex) ?? []), image]);
    }
  });
  for (const [factIndex, fact] of params.media.entries()) {
    if (isImageMediaFact(fact)) {
      projected.push(...(imagesByFact.get(factIndex) ?? []));
    } else if (isVideoMediaFact(fact)) {
      projected.push(
        params.options.provider
          ? await materializeProviderVideoFact(fact, params.budget, params.options)
          : { type: "text", text: PROVIDER_VIDEO_OMISSION.unsupported },
      );
    }
  }
  projected.push(...factlessImages);
  return projected;
}

export async function materializeToolResultVideoMessages(
  messages: AgentMessage[],
  options: ProviderVideoProjectionOptions & { videoBudget: { remaining: number } },
): Promise<AgentMessage[]> {
  if (!options.provider) {
    return messages;
  }
  const budget = options.videoBudget;
  const projected: AgentMessage[] = [];
  let changed = false;
  for (const message of messages) {
    projected.push(message);
    if (message.role !== "toolResult") {
      continue;
    }
    const media = readToolResultMediaFacts(message)?.filter(isVideoMediaFact) ?? [];
    if (media.length === 0) {
      continue;
    }
    const content: ModelInputContent[] = [
      { type: "text", text: "Video attachment returned by the readVideo tool." },
    ];
    for (const fact of media) {
      content.push(await materializeProviderVideoFact(fact, budget, options));
    }
    const providerMessage = {
      role: "user",
      content,
      timestamp: message.timestamp,
    } satisfies ProviderContext["messages"][number];
    changed = true;
    // SAFETY: Provider-only video carriers exist only during the exact dispatch.
    projected.push(providerMessage as AgentMessage);
  }
  return changed ? projected : messages;
}
