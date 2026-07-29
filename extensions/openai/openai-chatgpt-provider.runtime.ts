// Openai provider module implements model/runtime integration.
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { refreshOpenAICodexToken as refreshOpenAICodexTokenFromFlow } from "./openai-chatgpt-oauth-flow.runtime.js";
import type { OAuthCredentials } from "./openai-chatgpt-oauth-types.runtime.js";

/**
 * Default Shadowsocks endpoint used to reach OpenAI's auth server when the
 * gateway region is rejected by OpenAI with `unsupported_country_region_territory`.
 *
 * Mirrors `DEFAULT_CODEX_PROXY_URL` in `extensions/codex/src/app-server/transport-stdio.ts`
 * (v6.8 fix that injected proxy env into the Codex app-server child process). Bundle
 * runtime layers (`openai-chatgpt-provider.runtime.ts`, `openai-chatgpt-oauth.runtime.ts`)
 * resolve to this URL by default and forward it as a `PinnedDispatcherPolicy` to
 * `fetchWithSsrFGuard` via `mode: "trusted_explicit_proxy"`. Only OpenAI auth
 * endpoints (`https://auth.openai.com/oauth/token` and `/api/accounts/deviceauth/*`)
 * route through this proxy; minimax / Z.AI / other providers continue to use their
 * own fetch path which honors `models.providers.*.request.proxy`.
 */
export const DEFAULT_OPENAI_OAUTH_PROXY_URL = "http://127.0.0.1:1080";

/**
 * Resolve the dispatcher policy applied to OpenAI Codex OAuth token endpoints.
 *
 * Operators can override the default URL with `OPENCLAW_OPENAI_OAUTH_PROXY`
 * (e.g. `http://user:pass@host:port`). Setting `OPENCLAW_OPENAI_OAUTH_PROXY=""`
 * explicitly disables proxy injection even when the default would otherwise
 * apply. Returning `undefined` means callers should not forward any
 * `dispatcherPolicy` to `fetchWithSsrFGuard`, leaving the call in strict mode
 * (direct HTTPS).
 */
export function resolveOpenAIOAuthDispatcherPolicy(): PinnedDispatcherPolicy | undefined {
  const envOverride = process.env.OPENCLAW_OPENAI_OAUTH_PROXY;
  if (envOverride !== undefined && envOverride.trim().length === 0) {
    return undefined;
  }
  const url = (envOverride ?? DEFAULT_OPENAI_OAUTH_PROXY_URL).trim();
  return {
    mode: "explicit-proxy",
    proxyUrl: url,
    // `allowPrivateProxy: true` lets the dispatcher validate the proxy hostname
    // (127.0.0.1) against the SSRF policy without rejecting it as a private IP.
    // Target URLs (auth.openai.com) are still checked against the standard
    // public-hostname policy.
    allowPrivateProxy: true,
  };
}

const openAIOAuthDispatcherPolicy = resolveOpenAIOAuthDispatcherPolicy();

type OpenAICodexProviderRuntimeDeps = {
  getOAuthApiKey: typeof getOpenAICodexOAuthApiKey;
  refreshOpenAICodexToken: typeof refreshOpenAICodexTokenFromFlow;
};

export function createOpenAICodexProviderRuntime(deps: OpenAICodexProviderRuntimeDeps): {
  getOAuthApiKey: typeof getOAuthApiKey;
  refreshOpenAICodexToken: typeof refreshOpenAICodexToken;
} {
  return {
    async getOAuthApiKey(...args) {
      return await deps.getOAuthApiKey(...args);
    },
    async refreshOpenAICodexToken(refreshToken) {
      return await deps.refreshOpenAICodexToken(refreshToken, {
        dispatcherPolicy: openAIOAuthDispatcherPolicy,
      });
    },
  };
}

const runtime = createOpenAICodexProviderRuntime({
  getOAuthApiKey: getOpenAICodexOAuthApiKey,
  refreshOpenAICodexToken: refreshOpenAICodexTokenFromFlow,
});

export async function getOAuthApiKey(
  ...args: Parameters<typeof getOpenAICodexOAuthApiKey>
): Promise<Awaited<ReturnType<typeof getOpenAICodexOAuthApiKey>>> {
  return await runtime.getOAuthApiKey(...args);
}

export async function refreshOpenAICodexToken(
  ...args: Parameters<typeof refreshOpenAICodexTokenFromFlow>
): Promise<Awaited<ReturnType<typeof refreshOpenAICodexTokenFromFlow>>> {
  return await runtime.refreshOpenAICodexToken(...args);
}

async function getOpenAICodexOAuthApiKey(
  providerId: string,
  credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
  if (providerId !== "openai") {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  let creds = credentials[providerId];
  if (!creds) {
    return null;
  }
  if (Date.now() >= creds.expires) {
    creds = await refreshOpenAICodexTokenFromFlow(creds.refresh, {
      dispatcherPolicy: openAIOAuthDispatcherPolicy,
    });
  }
  return { newCredentials: creds, apiKey: creds.access };
}
