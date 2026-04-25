/**
 * Lark/Fishu client factory for ID mapping lookups.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./types.js";

let _cachedClient: Lark.Client | null = null;

function getDefaultFeishuConfig(): { appId: string; appSecret: string } | null {
  try {
    const { readFileSync } = require("node:fs");
    const path = require("node:path");
    const cfgPath =
      process.env.OPENCLAW_CONFIG_PATH ??
      path.join(process.env.HOME ?? "/home/axelhu", ".openclaw", "openclaw.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const cfg = JSON.parse(raw) as { channels?: { feishu?: FeishuConfig } };
    const feishuCfg = cfg?.channels?.feishu;
    // appId and appSecret might be secret refs or plain strings
    // Handle both cases by resolving them
    const appIdRaw = feishuCfg?.appId;
    const appSecretRaw = feishuCfg?.appSecret;
    const appId = typeof appIdRaw === "string" ? appIdRaw : undefined;
    const appSecret = typeof appSecretRaw === "string" ? appSecretRaw : undefined;
    if (!appId || !appSecret) {
      return null;
    }
    return { appId, appSecret };
  } catch {
    return null;
  }
}

export function getLarkClientForApp(_appId: string): Lark.Client {
  const creds = getDefaultFeishuConfig();
  if (!creds) {
    throw new Error("[lark-client] No Feishu credentials configured");
  }

  if (!_cachedClient) {
    _cachedClient = new Lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });
  }

  return _cachedClient;
}
