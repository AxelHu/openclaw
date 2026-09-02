import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_HOSTED_MAX_BYTES,
  DEFAULT_VIDEO_INLINE_MAX_BYTES,
  decideVideoDelivery,
  resolveVideoDeliveryPolicy,
  resolveVideoReadMaxBytes,
} from "./video-inline-policy.js";

describe("video delivery policy", () => {
  it("uses the provider byte budgets by default", () => {
    expect(resolveVideoDeliveryPolicy(undefined, "minimax")).toEqual({
      mode: "auto",
      inlineMaxBytes: DEFAULT_VIDEO_INLINE_MAX_BYTES,
      hostedMaxBytes: DEFAULT_VIDEO_HOSTED_MAX_BYTES,
    });
  });

  it("resolves configured inline and hosted limits", () => {
    const cfg = {
      models: {
        providers: {
          minimax: {
            media: {
              video: { mode: "hosted", inlineMaxBytes: 1024, hostedMaxBytes: 4096 },
            },
          },
        },
      },
    };
    expect(resolveVideoDeliveryPolicy(cfg as never, "minimax")).toEqual({
      mode: "hosted",
      inlineMaxBytes: 1024,
      hostedMaxBytes: 4096,
    });
  });

  it("caps configured byte budgets at the runtime hosted-video ceiling", () => {
    const cfg = {
      models: {
        providers: {
          minimax: {
            media: {
              video: {
                inlineMaxBytes: Number.MAX_SAFE_INTEGER,
                hostedMaxBytes: Number.MAX_SAFE_INTEGER,
              },
            },
          },
        },
      },
    };

    expect(resolveVideoDeliveryPolicy(cfg as never, "minimax")).toEqual({
      mode: "auto",
      inlineMaxBytes: DEFAULT_VIDEO_HOSTED_MAX_BYTES,
      hostedMaxBytes: DEFAULT_VIDEO_HOSTED_MAX_BYTES,
    });
  });

  it("resolves regional provider aliases against canonical config", () => {
    const cfg = {
      models: {
        providers: {
          minimax: {
            media: { video: { mode: "hosted", hostedMaxBytes: 2048 } },
          },
        },
      },
    };

    expect(resolveVideoDeliveryPolicy(cfg as never, "minimax-cn")).toMatchObject({
      mode: "hosted",
      hostedMaxBytes: 2048,
    });
  });

  it("keeps auto inline under the cap and hosts larger files", () => {
    const policy = { mode: "auto" as const, inlineMaxBytes: 100, hostedMaxBytes: 1000 };
    expect(decideVideoDelivery({ sizeBytes: 100, policy, canHost: true })).toBe("inline");
    expect(decideVideoDelivery({ sizeBytes: 101, policy, canHost: true })).toBe("hosted");
    expect(decideVideoDelivery({ sizeBytes: 101, policy, canHost: false })).toBe("unsupported");
  });

  it("honors explicit inline and hosted modes without silent fallback", () => {
    const inline = { mode: "inline" as const, inlineMaxBytes: 100, hostedMaxBytes: 1000 };
    const hosted = { mode: "hosted" as const, inlineMaxBytes: 100, hostedMaxBytes: 1000 };
    expect(decideVideoDelivery({ sizeBytes: 101, policy: inline, canHost: true })).toBe(
      "unsupported",
    );
    expect(decideVideoDelivery({ sizeBytes: 1, policy: hosted, canHost: true })).toBe("hosted");
    expect(decideVideoDelivery({ sizeBytes: 1, policy: hosted, canHost: false })).toBe(
      "unsupported",
    );
  });

  it("caps reads at the largest usable delivery path", () => {
    const policy = { mode: "auto" as const, inlineMaxBytes: 100, hostedMaxBytes: 1000 };
    expect(resolveVideoReadMaxBytes({ policy, canHost: true })).toBe(1000);
    expect(resolveVideoReadMaxBytes({ policy, canHost: false })).toBe(100);
    expect(resolveVideoReadMaxBytes({ policy, canHost: true, requestedMaxBytes: 50 })).toBe(50);
    expect(resolveVideoReadMaxBytes({ policy, canHost: true, requestedMaxBytes: 5000 })).toBe(1000);
    expect(
      resolveVideoReadMaxBytes({
        policy: {
          mode: "auto",
          inlineMaxBytes: Number.MAX_SAFE_INTEGER,
          hostedMaxBytes: Number.MAX_SAFE_INTEGER,
        },
        canHost: true,
      }),
    ).toBe(DEFAULT_VIDEO_HOSTED_MAX_BYTES);
  });

  it("keeps the larger inline path available when the hosted cap is smaller", () => {
    const policy = { mode: "auto" as const, inlineMaxBytes: 1000, hostedMaxBytes: 100 };
    expect(resolveVideoReadMaxBytes({ policy, canHost: true })).toBe(1000);
    expect(decideVideoDelivery({ sizeBytes: 500, policy, canHost: true })).toBe("inline");
  });
});
