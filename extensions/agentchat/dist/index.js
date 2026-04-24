// ============================================================================
// AgentChat OpenClaw Channel Plugin (bundled entry for v2026.4.15+)
// ============================================================================

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { agentchatPlugin, setAgentChatRuntime, startAgentChatClient } from "./channel.js";
export { agentchatPlugin } from "./channel.js";

// Bridge: read config from plugins.entries.agentchat.config if channels.agentchat is absent
function bridgeConfig(cfg) {
    if (cfg?.channels?.agentchat)
        return cfg;
    const pluginCfg = cfg?.plugins?.entries?.agentchat?.config;
    if (!pluginCfg)
        return cfg;
    const accounts = {};
    if (pluginCfg.accounts && Array.isArray(pluginCfg.accounts)) {
        for (const entry of pluginCfg.accounts) {
            const acct = entry.account ?? entry;
            const id = entry.id ?? acct.username ?? "default";
            accounts[id] = {
                username: acct.username ?? "",
                password: acct.password ?? "",
                agentId: acct.agentId ?? id,
                agentName: acct.agentName ?? acct.agentId ?? id,
                model: acct.model,
            };
        }
    }
    else {
        const acct = pluginCfg.account ?? pluginCfg;
        const id = "default";
        accounts[id] = {
            username: acct.username ?? "",
            password: acct.password ?? "",
            agentId: pluginCfg.agentId ?? id,
            agentName: pluginCfg.agentName ?? pluginCfg.agentId ?? id,
            model: pluginCfg.model,
        };
    }
    return {
        ...cfg,
        channels: {
            ...(cfg?.channels || {}),
            agentchat: {
                serverUrl: pluginCfg.serverUrl,
                restUrl: pluginCfg.restUrl,
                accounts,
            },
        },
    };
}
export default defineBundledChannelEntry({
    id: "agentchat",
    name: "AgentChat",
    description: "AgentChat messaging platform — WebSocket-based IM for agents and humans",
    importMetaUrl: import.meta.url,
    plugin: {
        specifier: "./channel-plugin-api.js",
        exportName: "agentchatPlugin",
    },
    runtime: {
        specifier: "./runtime-api.js",
        exportName: "setAgentChatRuntime",
    },
    registerFull(api) {
        const rawCfg = api.config;
        const cfg = bridgeConfig(rawCfg);
        console.log("[agentchat][REG-FULL] start, runtime=" + !!api.runtime);
        if (cfg.channels?.agentchat) {
            console.log("[agentchat][REG-FULL] calling startAgentChatClient...");
            try {
                startAgentChatClient(cfg);
                console.log("[agentchat][REG-FULL] startAgentChatClient done");
            }
            catch (err) {
                console.error("[agentchat][REG-FULL] startAgentChatClient threw:", err.message, err.stack);
            }
        }
        else {
            console.log("[agentchat][REG-FULL] NO cfg.channels.agentchat");
        }
    },
});
//# sourceMappingURL=index.js.map
