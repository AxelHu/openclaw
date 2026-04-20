// ============================================================================
// AgentChat OpenClaw Channel Plugin
// ============================================================================

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { agentchatPlugin, setAgentChatRuntime, startAgentChatClient } from "./channel.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

export { agentchatPlugin } from "./channel.js";

export default defineBundledChannelEntry({
  id: "agentchat",
  name: "AgentChat",
  description: "AgentChat messaging platform — WebSocket-based IM for agents and humans",
  plugin: agentchatPlugin,
  setRuntime: setAgentChatRuntime,
  registerFull(api: OpenClawPluginApi) {
    console.error("[AgentChat] registerFull ENTRY apiKeys=", Object.keys(api ?? {}));
    const cfg = (api as any).config ?? (api as any).getConfig?.() ?? {};
    console.error("[AgentChat] registerFull cfg.channels=", cfg?.channels ? Object.keys(cfg.channels) : 'undefined/null');
    if (cfg.channels?.agentchat) {
      console.error("[AgentChat] registerFull: calling startAgentChatClient now");
      startAgentChatClient(cfg);
    } else {
      console.error("[AgentChat] registerFull: NO agentchat channel, skipping. cfg=", JSON.stringify(cfg).slice(0,200));
    }
  },
});
