import { describe, expect, it } from "vitest";
import { resolveModelProviderRouteOverridePresence } from "./model-provider-config.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const proxy = { mode: "explicit-proxy", url: "http://127.0.0.1:1080" };
const request = { allowPrivateNetwork: true, proxy };
function classify(fields: Record<string, unknown> = {}) {
  return resolveModelProviderRouteOverridePresence({
    provider: "openai",
    modelId: "gpt-6-astra",
    authoredConfig: {
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api",
            models: [{ id: "gpt-6-astra" }],
            request,
            ...fields,
          },
        },
      },
    } as OpenClawConfig,
  });
}

describe("native environment proxy transport projection", () => {
  it("retains a distinct proxy fact rather than pretending there are no overrides", () => {
    expect(classify()).toBe("environment-proxy");
  });
  it("preserves advanced native reasoning metadata alongside the proxy", () => {
    expect(
      classify({
        models: [
          {
            id: "gpt-6-astra",
            compat: {
              supportsReasoningEffort: true,
              supportedReasoningEfforts: ["high", "xhigh", "max"],
            },
          },
        ],
      }),
    ).toBe("environment-proxy");
  });
  it.each([
    ["private network opt-in missing", { request: { proxy } }],
    ["private network denied", { request: { ...request, allowPrivateNetwork: false } }],
    ["standalone network override", { request: { allowPrivateNetwork: true } }],
    ["custom request headers", { request: { ...request, headers: { "x-route": "custom" } } }],
    ["custom request auth", { request: { ...request, auth: { mode: "provider-default" } } }],
    ["origin TLS", { request: { ...request, tls: { serverName: "custom.example" } } }],
    ["proxy TLS", { request: { ...request, proxy: { ...proxy, tls: {} } } }],
    ["env proxy discovery", { request: { ...request, proxy: { mode: "env-proxy" } } }],
    ["unknown request field", { request: { ...request, futurePolicy: true } }],
    ["unknown proxy field", { request: { ...request, proxy: { ...proxy, futurePolicy: true } } }],
    ["provider header", { headers: { "x-route": "custom" } }],
    ["provider params", { params: { temperature: 0.1 } }],
    ["timeout", { timeoutSeconds: 20 }],
    ["authorization switch", { authHeader: false }],
    ["local service", { localService: {} }],
    ["model params", { models: [{ id: "gpt-6-astra", params: { temperature: 0.1 } }] }],
    ["model header", { models: [{ id: "gpt-6-astra", headers: { "x-route": "custom" } }] }],
    ["model behavior", { models: [{ id: "gpt-6-astra", compat: { supportsStore: false } }] }],
  ])("keeps %s on the authored adapter", (_label, fields) => {
    expect(classify(fields)).toBe("present");
  });
  it.each([
    "",
    "not-a-url",
    "socks5://127.0.0.1:1080",
    "http://user:secret@127.0.0.1:1080",
    "https://127.0.0.1:1080",
    "http://127.0.0.1:1080/path",
    "http://127.0.0.1:1080/?x=1",
    "http://127.0.0.1:1080/#x",
    "http://proxy.example.test:1080",
  ])("does not claim unsupported proxy URL %s is reproducible", (url) => {
    expect(classify({ request: { ...request, proxy: { ...proxy, url } } })).toBe("present");
  });
  it.each(["http://localhost:1080", "http://[::1]:1080", "http://127.0.0.1:1080/"])(
    "supports explicit loopback HTTP proxy %s",
    (url) => {
      expect(classify({ request: { ...request, proxy: { ...proxy, url } } })).toBe(
        "environment-proxy",
      );
    },
  );
});
