// ============================================================================
// AgentChat OpenClaw Channel Plugin
// ============================================================================

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { agentchatPlugin, setAgentChatRuntime, startAgentChatClient } from "./channel.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export { agentchatPlugin } from "./channel.js";

// Bridge: read config from plugins.entries.agentchat.config if channels.agentchat is absent
function bridgeConfig(cfg: any): any {
  if (cfg?.channels?.agentchat) return cfg;
  const pluginCfg = cfg?.plugins?.entries?.agentchat?.config;
  if (pluginCfg) {
    return {
      ...cfg,
      channels: {
        ...(cfg?.channels || {}),
        agentchat: {
          serverUrl: pluginCfg.serverUrl,
          restUrl: pluginCfg.restUrl,
          username: pluginCfg.account?.username ?? pluginCfg.username ?? "",
          password: pluginCfg.account?.password ?? pluginCfg.password ?? "",
          agentId: pluginCfg.agentId ?? "default",
          agentName: pluginCfg.agentName ?? pluginCfg.agentId ?? "default",
        }
      }
    };
  }
  return cfg;
}

export default defineChannelPluginEntry({
  id: "agentchat",
  name: "AgentChat",
  description: "AgentChat messaging platform — WebSocket-based IM for agents and humans",
  plugin: agentchatPlugin,
  setRuntime: setAgentChatRuntime,
  registerFull(api: OpenClawPluginApi) {
    const rawCfg = api.config;
    const cfg = bridgeConfig(rawCfg);
    console.log("[agentchat][REG-FULL] start, runtime=" + !!api.runtime);
    if (cfg.channels?.agentchat) {
      console.log("[agentchat][REG-FULL] calling startAgentChatClient...");
      try {
        startAgentChatClient(cfg);
        console.log("[agentchat][REG-FULL] startAgentChatClient done");
      } catch (err: any) {
        console.error("[agentchat][REG-FULL] startAgentChatClient threw:", err.message, err.stack);
      }
    } else {
      console.log("[agentchat][REG-FULL] NO cfg.channels.agentchat");
    }
  },
});