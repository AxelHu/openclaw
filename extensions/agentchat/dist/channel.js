// ============================================================================
// AgentChat Channel Plugin
// ============================================================================
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { createWSClient } from "./ws-client.js";
import { URL } from "url";
// ── Plugin ID ────────────────────────────────────────────────────────────────
const PLUGIN_ID = "agentchat";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
export const AgentChatConfigSchema = buildChannelConfigSchema({
    serverUrl: {
        type: "string",
        label: "WebSocket Server URL",
        placeholder: "ws://localhost:20203",
        required: true,
    },
    restUrl: {
        type: "string",
        label: "REST API URL",
        placeholder: "http://localhost:20202",
        required: true,
    },
    username: {
        type: "string",
        label: "Username",
        required: true,
    },
    password: {
        type: "string",
        label: "Password",
        sensitive: true,
        required: true,
    },
    agentId: {
        type: "string",
        label: "Agent ID",
        description: "Unique agent identifier used for message routing (defaults to accountId)",
        required: false,
    },
    agentName: {
        type: "string",
        label: "Agent Name",
        description: "Human-readable bot name (e.g. 小爪爪), used in session keys",
        required: false,
    },
});
function listAgentChatAccountIds(cfg) {
    return Object.keys(cfg.channels?.agentchat?.accounts ?? {}).length > 0
        ? Object.keys(cfg.channels.agentchat.accounts)
        : [DEFAULT_ACCOUNT_ID];
}
function resolveAgentChatAccount(cfg, accountId) {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const channel = cfg.channels?.agentchat ?? {};
    const account = channel.accounts?.[id] ?? {};
    return {
        accountId: id,
        config: {
            serverUrl: account.serverUrl ?? channel.serverUrl ?? "ws://localhost:20203",
            restUrl: account.restUrl ?? channel.restUrl ?? "http://localhost:20202",
            username: account.username ?? channel.username ?? "",
            password: account.password ?? channel.password ?? "",
            agentId: account.agentId ?? id, // 默认用 accountId 作为 agentId
            agentName: account.agentName ?? account.agentId ?? id, // 用于 session key，默认用 agentId
        },
        enabled: account.enabled !== false,
    };
}
// ── URL validation helper ───────────────────────────────────────────────────
function isValidUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "ws:" || url.protocol === "wss:" || url.protocol === "http:" || url.protocol === "https:";
    }
    catch {
        return false;
    }
}
// ── WS Client pool (one per accountId) ──────────────────────────────────────
let wsClients = new Map();
let agentNames = new Map(); // accountId → agentName
let accountUserIds = new Map(); // accountId → server userId
let globalRuntime = null;
function getWsClient(accountId) {
    if (!wsClients.has(accountId)) {
        const client = createWSClient();
        wsClients.set(accountId, client);
    }
    return wsClients.get(accountId);
}
function setAgentName(accountId, agentName) {
    agentNames.set(accountId, agentName);
}
function getAgentName(accountId) {
    return agentNames.get(accountId) ?? accountId;
}
// ── Inbound: route WS messages to agent sessions ─────────────────────────────
function makeOnMessageHandler(runtime, accountId, agentName) {
    return (msg) => {
        if (msg.type === "message") {
            handleIncomingMessage(runtime, accountId, agentName, msg);
        }
        else if (msg.type === "invite_notification") {
            handleInviteNotification(runtime, accountId, msg);
        }
        else if (msg.type === "agent_message") {
            // Direct message from another user to this agent (forwarded by server)
            handleAgentMessage(runtime, accountId, agentName, msg);
        }
    };
}
async function handleIncomingMessage(runtime, accountId, agentName, payload) {
    console.log("[agentchat] HIM called, msgType=", payload.type, "content=", (payload.content ?? "").slice(0, 50));
    // Payload IS the MessageObject (no extra "event" wrapper at this level)
    const eventId = payload.event_id ?? payload.eventId ?? "";
    const groupId = String(payload.group_id ?? payload.groupId ?? "");
    const userId = String(payload.sender_id ?? payload.userId ?? "");
    const username = payload.sender_name ?? payload.username ?? "";
    const content = payload.content ?? "";
    const createdAt = payload.created_at ?? payload.createdAt ?? "";
    // Build session key in ACP format: agent:{agentId}:group:{groupId} or agent:{agentId}:user:{userId}
    const client = getWsClient(accountId);
    const agentUserId = client.getUserId();
    if (userId === agentUserId) {
        console.log("[agentchat] skipping own message, eventId=", eventId);
        return;
    }
    const sessionKey = groupId
        ? `agent:${agentName}:group:${groupId}`
        : `agent:${agentName}:user:${userId}`;
    // wasMentioned: check if agentUserId appears in mentions list (mentions contains {userId,...} from server)
    const msgMentions = Array.isArray(payload.mentions) ? payload.mentions : [];
    const wasMentioned = msgMentions.some((m) => m.userId === agentUserId);
    const text = content;
    // In group chats: skip if this agent was NOT mentioned (group broadcast includes all members,
    // but each agent should only process messages where it was explicitly named)
    if (groupId && !wasMentioned) {
        return;
    }
    try {
        // First record the inbound session
        const storePath = runtime.channel.session.resolveStorePath(null);
        await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey,
            ctx: {
                SessionKey: sessionKey,
                BodyForAgent: text,
                MessageRole: "user",
                AccountId: accountId,
                Channel: PLUGIN_ID,
                Surface: "agentchat",
                Provider: "agentchat",
                MessageSid: String(eventId),
                SenderId: userId,
                SenderName: username,
                SenderUsername: username,
                ConversationLabel: groupId || undefined,
                GroupSubject: groupId ? `group:${groupId}` : undefined,
                WasMentioned: wasMentioned,
                ChatType: groupId ? "group" : "direct",
            },
            createIfMissing: true,
            onRecordError: (err) => console.error("[agentchat] recordInboundSession failed:", err),
        });
        // Then dispatch the reply
        const deliver = async (payload) => {
            console.log("[agentchat] agent reply received, text=", payload.text?.slice(0, 100));
            const replyContent = payload.text ?? "";
            if (!replyContent) {
                return;
            }
            // Send the reply back via the agentchat WS client
            const client = getWsClient(accountId);
            if (!client || !client.isConnected()) {
                console.error("[agentchat] WS client not connected, cannot send reply");
                return;
            }
            if (groupId) {
                // Send to group using send_text
                client.send({
                    type: "send_text",
                    content: replyContent,
                    groupId: groupId,
                });
                console.log("[agentchat] reply sent to group", groupId);
            }
            else {
                // Send DM using agent_message
                client.send({
                    type: "agent_message",
                    toUserId: userId,
                    content: replyContent,
                });
                console.log("[agentchat] reply sent to user", userId);
            }
        };
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: {
                SessionKey: sessionKey,
                BodyForAgent: text,
                MessageRole: "user",
                AccountId: accountId,
                Channel: PLUGIN_ID,
                Surface: "agentchat",
                Provider: "agentchat",
                MessageSid: String(eventId),
                SenderId: userId,
                SenderName: username,
                SenderUsername: username,
                ConversationLabel: groupId || undefined,
                GroupSubject: groupId ? `group:${groupId}` : undefined,
                WasMentioned: wasMentioned,
                ChatType: groupId ? "group" : "direct",
            },
            cfg: runtime.config,
            dispatcherOptions: {
                deliver,
                onError: (err) => console.error("[agentchat] dispatch error:", err),
            },
        });
        console.log("[agentchat] dispatchReplyWithBufferedBlockDispatcher completed");
    }
    catch (err) {
        console.error("[agentchat] dispatchReplyWithBufferedBlockDispatcher failed:", err);
    }
}
async function handleInviteNotification(runtime, accountId, payload) {
    runtime.log?.(`[agentchat] invite_notification: group=${payload.group_name ?? payload.groupId}`);
}
/**
 * Handle direct agent_message from another user.
 * The message was forwarded by the server when a user sent a direct message to the agent.
 * We route it to the agent session as a DM: agentchat:agent:{agentName}:account:{accountId}:user:{fromUserId}
 */
async function handleAgentMessage(runtime, accountId, agentName, payload) {
    const fromUserId = String(payload.fromUserId ?? "");
    const fromUsername = payload.fromUsername ?? "Unknown";
    const content = payload.content ?? "";
    // Route as a DM session: the sender is the "from" user
    const sessionKey = `agent:default:user:${fromUserId}`;
    try {
        // First record the inbound session
        const storePath = runtime.channel.session.resolveStorePath(null);
        await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey,
            ctx: {
                SessionKey: sessionKey,
                BodyForAgent: content,
                MessageRole: "user",
                AccountId: accountId,
                Channel: PLUGIN_ID,
                Surface: "agentchat",
                Provider: "agentchat",
                SenderId: fromUserId,
                SenderName: fromUsername,
                SenderUsername: fromUsername,
                ChatType: "direct",
            },
            createIfMissing: true,
            onRecordError: (err) => console.error("[agentchat] recordInboundSession (DM) failed:", err),
        });
        // Then dispatch the reply
        const deliver = async (payload) => {
            const replyContent = payload.text ?? "";
            if (!replyContent) {
                return;
            }
            const client = getWsClient(accountId);
            if (!client || !client.isConnected()) {
                console.error("[agentchat] WS client not connected for DM reply");
                return;
            }
            client.send({
                type: "agent_message",
                toUserId: fromUserId,
                content: replyContent,
            });
            console.log("[agentchat] DM reply sent to user", fromUserId);
        };
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: {
                SessionKey: sessionKey,
                BodyForAgent: content,
                MessageRole: "user",
                AccountId: accountId,
                Channel: PLUGIN_ID,
                Surface: "agentchat",
                Provider: "agentchat",
                SenderId: fromUserId,
                SenderName: fromUsername,
                SenderUsername: fromUsername,
                ChatType: "direct",
            },
            cfg: runtime.config,
            dispatcherOptions: {
                deliver,
                onError: (err) => console.error("[agentchat] dispatch error (DM):", err),
            },
        });
        console.log("[agentchat] dispatchReplyWithBufferedBlockDispatcher (DM) completed");
    }
    catch (err) {
        console.error("[agentchat] dispatchReplyWithBufferedBlockDispatcher (DM) failed:", err);
    }
}
// ── Plugin definition ────────────────────────────────────────────────────────
export const agentchatPlugin = createChatChannelPlugin({
    base: {
        id: PLUGIN_ID,
        gateway: {
            startAccount: async (ctx) => {
                const { cfg, accountId } = ctx;
                const account = resolveAgentChatAccount(cfg, accountId);
                const client = getWsClient(accountId);
                setAgentName(accountId, account.config.agentName ?? accountId);
                // Skip if already connected or connecting (don't throw, just return to avoid restart loop)
                if (client.isConnected()) {
                    ctx.log?.info(`[agentchat][${accountId}] WS already connected, skipping`);
                    return;
                }
                if (client.connecting) {
                    ctx.log?.info(`[agentchat][${accountId}] WS already connecting, skipping`);
                    return;
                }
                client.onMessage(makeOnMessageHandler(globalRuntime, accountId, account.config.agentName ?? accountId));
                client.onError((err) => {
                    ctx.log?.error(`[agentchat][${accountId}] WS error: ${err.message}`);
                });
                await client.connect(account.config);
                ctx.log?.info(`[agentchat][${accountId}] WS connected to ${account.config.serverUrl}`);
            },
            stopAccount: async (ctx) => {
                const { accountId } = ctx;
                const client = wsClients.get(accountId);
                if (client) {
                    client.disconnect?.();
                    wsClients.delete(accountId);
                    agentNames.delete(accountId);
                }
            },
        },
        meta: {
            id: PLUGIN_ID,
            label: "AgentChat",
            selectionLabel: "AgentChat",
            docsPath: "/docs/channels/agentchat",
            blurb: "AgentChat — Agent-to-human and Agent-to-Agent messaging",
            systemImage: "💬",
        },
        capabilities: {
            chatTypes: ["group", "dm"],
            threads: false,
            reactions: false,
            edit: false,
            reply: false,
            media: false,
        },
        config: {
            listAccountIds: listAgentChatAccountIds,
            resolveAccount: resolveAgentChatAccount,
            isConfigured: (account) => {
                const { serverUrl, username, password } = account.config;
                return (typeof serverUrl === "string" &&
                    serverUrl.length > 0 &&
                    isValidUrl(serverUrl) &&
                    typeof username === "string" &&
                    username.length > 0 &&
                    typeof password === "string" &&
                    password.length > 0);
            },
            unconfiguredReason: () => "AgentChat account not configured (valid serverUrl, username, password required)",
            describeAccount: (account) => ({
                accountId: account.accountId,
                status: account.enabled ? "active" : "disabled",
                summary: {
                    serverUrl: account.config.serverUrl,
                    username: account.config.username,
                },
            }),
            disabledReason: (account) => account.enabled ? undefined : "Account is disabled",
        },
        configSchema: AgentChatConfigSchema,
        // ── Outbound ─────────────────────────────────────────────────────────────
        outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => {
                if (!to) {
                    return { ok: false, error: new Error("No target specified") };
                }
                return { ok: true, to };
            },
            sendText: async ({ cfg, accountId, to, text, replyToId, identity }) => {
                const account = resolveAgentChatAccount(cfg, accountId);
                const client = getWsClient(accountId);
                setAgentName(accountId, account.config.agentName ?? accountId);
                if (!client.isConnected()) {
                    await client.connect(account.config);
                    // Attach runtime handlers after connecting
                    client.onMessage(makeOnMessageHandler(globalRuntime, accountId, account.config.agentName ?? accountId));
                    client.onError((err) => globalRuntime?.error?.(`[agentchat][${accountId}] WS error: ${err.message}`));
                }
                // Parse target: "group:{id}" or "user:{id}"
                const isGroup = to.startsWith("group:");
                const targetId = to.replace(/^(group:|user:)/, "");
                if (isGroup) {
                    // Group message: use send_text (server broadcasts to group members)
                    client.send({
                        type: "send_text",
                        content: text,
                        groupId: targetId,
                        replyTo: replyToId ? Number(replyToId) : undefined,
                    });
                }
                else {
                    // DM to a user: use agent_message (server forwards to target user's WS)
                    client.send({
                        type: "agent_message",
                        toUserId: targetId,
                        content: text,
                    });
                }
                return [{ delivered: true, messageId: `local_${Date.now()}` }];
            },
        },
        // ── Messaging (inbound routing) ──────────────────────────────────────────
        messaging: {
            normalizeTarget: (raw) => {
                const trimmed = raw.trim();
                if (!trimmed) {
                    return undefined;
                }
                return trimmed.replace(/^agentchat:/i, "");
            },
            targetResolver: {
                looksLikeId: (id) => /^\d+$/.test(id ?? ""),
                hint: "<groupId|userId>",
            },
        },
        // ── Tools (agent-callable) ──────────────────────────────────────────────
        tools: {
            message: {
                description: "Send a rich message via AgentChat. Use this for text/markdown content, or when you need to specify content type explicitly.",
                parameters: {
                    type: "object",
                    properties: {
                        accountId: {
                            type: "string",
                            description: "The account ID to send from (from the session's accountId)",
                        },
                        target: {
                            type: "string",
                            description: "Target in format 'group:{groupId}' or 'user:{userId}'",
                        },
                        content: {
                            type: "string",
                            description: "Message content (text, markdown, or URL for media)",
                        },
                        contentType: {
                            type: "string",
                            enum: ["text", "markdown", "html"],
                            default: "text",
                            description: "Content type of the message",
                        },
                        replyTo: {
                            type: "string",
                            description: "Optional message ID to reply to",
                        },
                        mentions: {
                            type: "array",
                            items: { type: "string" },
                            description: "User IDs to mention in this message (e.g. [\"d6680324-7abe-4028-ade6-4e7e9a7d2e9d\"])",
                        },
                    },
                    required: ["accountId", "target", "content"],
                },
                handler: async ({ cfg, accountId, target, content, contentType = "text", replyTo, mentions }) => {
                    const account = resolveAgentChatAccount(cfg, accountId);
                    const client = getWsClient(accountId);
                    setAgentName(accountId, account.config.agentName ?? accountId);
                    if (!client.isConnected()) {
                        await client.connect(account.config);
                        client.onMessage(makeOnMessageHandler(globalRuntime, accountId, account.config.agentName ?? accountId));
                        client.onError((err) => globalRuntime?.error?.(`[agentchat][${accountId}] WS error: ${err.message}`));
                    }
                    const isGroup = target.startsWith("group:");
                    const targetId = target.replace(/^(group:|user:)/, "");
                    if (isGroup) {
                        // Send mentions as userId strings — server resolves to usernames and computes offsets
                        client.send({
                            type: "send_text",
                            content,
                            contentType,
                            groupId: targetId,
                            replyTo: replyTo ? Number(replyTo) : undefined,
                            mentions: mentions && mentions.length > 0 ? mentions : undefined,
                        });
                    }
                    else {
                        client.send({
                            type: "agent_message",
                            toUserId: targetId,
                            content,
                            contentType,
                        });
                    }
                    return { delivered: true, messageId: `msg_${Date.now()}` };
                },
            },
        },
    },
    // ── Security ────────────────────────────────────────────────────────────────
    security: {
        resolveDmPolicy: () => "open",
        resolveDmAllowFrom: () => undefined,
        resolveGroupPolicy: () => "open",
    },
});
// ── Runtime injection ────────────────────────────────────────────────────────
export function setAgentChatRuntime(runtime) {
    globalRuntime = runtime;
    for (const [accountId, client] of wsClients) {
        client.onMessage(makeOnMessageHandler(runtime, accountId, getAgentName(accountId)));
        client.onError((err) => runtime.error?.(`[agentchat][${accountId}] WS error: ${err.message}`));
    }
}
// ── Bootstrap: connect WS when plugin starts ─────────────────────────────────
export function startAgentChatClient(cfg) {
    const accountIds = listAgentChatAccountIds(cfg);
    for (const accountId of accountIds) {
        const account = resolveAgentChatAccount(cfg, accountId);
        if (!account.enabled) {
            continue;
        }
        const client = getWsClient(accountId);
        setAgentName(accountId, account.config.agentName ?? accountId);
        // Skip if already connected or connecting
        if (client.isConnected() || client.connecting) {
            continue;
        }
        client.onMessage(makeOnMessageHandler(globalRuntime, accountId, account.config.agentName ?? accountId));
        client.onError((err) => {
            globalRuntime?.error?.(`[agentchat][${accountId}] WS error: ${err.message}`);
        });
        client.connect(account.config).catch((err) => {
            globalRuntime?.error?.(`[agentchat][${accountId}] connect failed: ${err}`);
        });
    }
}
//# sourceMappingURL=channel.js.map