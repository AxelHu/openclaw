/**
 * Feishu API client factory for ID mapping lookups.
 * Caches one Client instance per appId so that multi-bot setups
 * each use their own credentials.
 */

import * as Lark from "@larksuiteoapi/node-sdk";

const _clientCache = new Map<string, Lark.Client>();

/**
 * Register credentials for an appId.
 * Call this during account startup so that
 * `getFeishuClientForApp` can create properly authenticated clients.
 */
export function registerFeishuAppCredentials(appId: string, appSecret: string): void {
  if (_clientCache.has(appId)) {
    return; // already initialised
  }
  _clientCache.set(
    appId,
    new Lark.Client({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    }),
  );
}

/**
 * Get a Feishu API Client for the given appId.
 * The credentials must have been registered beforehand via
 * `registerFeishuAppCredentials` (typically at bot startup).
 */
export function getFeishuClientForApp(appId: string): Lark.Client {
  const client = _clientCache.get(appId);
  if (!client) {
    throw new Error(
      `[feishu-client] No credentials registered for appId "${appId}". ` +
        "Call registerFeishuAppCredentials() first.",
    );
  }
  return client;
}
