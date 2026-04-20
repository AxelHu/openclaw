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
    const cfg = api.config ?? {};
    if (cfg.channels?.agentchat) {
      startAgentChatClient(cfg);
    }
  },
});
