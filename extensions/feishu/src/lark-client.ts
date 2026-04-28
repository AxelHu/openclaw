/**
 * Lark/Feishu client factory for ID mapping lookups.
 * Caches one Client instance per appId so that multi-bot setups
 * each use their own credentials.
 */

import * as Lark from "@larksuiteoapi/node-sdk";

const _clientCache = new Map<string, Lark.Client>();

/**
 * Register (or update) credentials for an appId.
 * Call this during account resolution / bot startup so that
 * `getLarkClientForApp` can create properly authenticated clients.
 */
export function registerLarkAppCredentials(appId: string, appSecret: string): void {
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
 * Get a Lark Client for the given appId.
 * The credentials must have been registered beforehand via
 * `registerLarkAppCredentials` (typically at bot startup or first
 * message handling).
 */
export function getLarkClientForApp(appId: string): Lark.Client {
  const client = _clientCache.get(appId);
  if (!client) {
    throw new Error(
      `[lark-client] No credentials registered for appId "${appId}". ` +
        "Call registerLarkAppCredentials() first.",
    );
  }
  return client;
}
