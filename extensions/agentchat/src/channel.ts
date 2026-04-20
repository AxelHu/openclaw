// ============================================================================
// AgentChat Channel Plugin
// ============================================================================

import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import type {
  AgentChatConfig,
  ServerMessage,
} from "./types.js";
import { createWSClient } from "./ws-client.js";
import type { WSClient } from "./types.js";
import { URL } from "url";

// ── Plugin ID ────────────────────────────────────────────────────────────────
const PLUGIN_ID = "agentchat" as const;

// ── Account config ──────────────────────────────────────────────────────────

export interface ResolvedAgentChatAccount {
  accountId: string;
  config: AgentChatConfig;
  enabled: boolean;
}

// ── Config adapter ────────────────────────────────────────────────────────────

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
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
});

function listAgentChatAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(cfg.channels?.agentchat?.accounts ?? {}).length > 0
    ? Object.keys(cfg.channels!.agentchat!.accounts)
    : [DEFAULT_ACCOUNT_ID];
}

function resolveAgentChatAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAgentChatAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const channel = cfg.channels?.agentchat ?? {};
  const account = channel.accounts?.[id] ?? {};
  return {
    accountId: id,
    config: {
      // Per-account override takes priority; fall back to top-level channel URL
      serverUrl: account.serverUrl ?? channel.serverUrl ?? "ws://localhost:20203",
      restUrl: account.restUrl ?? channel.restUrl ?? "http://localhost:20202",
      username: account.username ?? "",
      password: account.password ?? "",
    },
    enabled: account.enabled !== false,
  };
}

// ── URL validation helper ───────────────────────────────────────────────────

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:" || url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ── WS Client singleton ──────────────────────────────────────────────────────

let globalWsClient: WSClient | null = null;
let globalRuntime: unknown = null;

function getWsClient(): WSClient {
  if (!globalWsClient) {
    globalWsClient = createWSClient();
  }
  return globalWsClient;
}

// ── Inbound: route WS messages to agent sessions ─────────────────────────────

function makeOnMessageHandler(runtime: unknown, accountId: string) {
  return (msg: ServerMessage) => {
    if (msg.type === "message") {
      void handleIncomingMessage(runtime, accountId, msg.payload as unknown);
    } else if (msg.type === "invite_notification") {
      void handleInviteNotification(runtime, accountId, msg.payload as unknown);
    }
  };
}

async function handleIncomingMessage(
  runtime: unknown,
  accountId: string,
  payload: unknown
) {
  // Payload IS the MessageObject (no extra "event" wrapper at this level)
  const eventId = payload.event_id ?? payload.eventId ?? "";
  const groupId = String(payload.group_id ?? payload.groupId ?? "");
  const userId = String(payload.sender_id ?? payload.userId ?? "");
  const username = payload.sender_name ?? payload.username ?? "";
  const content = payload.content ?? "";
  const _createdAt = payload.created_at ?? payload.createdAt ?? "";

  // Build session key: group-based routing
  const sessionKey = groupId
    ? `agentchat:group:${groupId}`
    : `agentchat:user:${userId}`;

  // Extract and strip @mentions for clean text
  const mentions = extractMentions(content);
  const wasMentioned = mentions.length > 0;
  const text = stripMentions(content, mentions);

  // Deliver to agent session
  try {
    runtime.deliverMessage({
      sessionKey,
      channel: PLUGIN_ID,
      text,
      wasMentioned,
      accountId,
      threadId: groupId || undefined,
      senderId: userId,
      senderName: username,
      messageId: String(eventId),
      rawEvent: payload,
    });
  } catch (err) {
    runtime.error?.(`[agentchat] deliverMessage failed: ${String(err)}`);
  }
}

async function handleInviteNotification(
  runtime: unknown,
  accountId: string,
  payload: unknown
) {
  runtime.log?.(`[agentchat] invite_notification: group=${payload.group_name ?? payload.groupId}`);
}

function extractMentions(content: string): string[] {
  const mentions: string[] = [];
  const regex = /@([\w\u4e00-\u9fa5]{1,32})/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    mentions.push(match[1]);
  }
  return [...new Set(mentions)];
}

function stripMentions(content: string, mentions: string[]): string {
  let text = content;
  for (const mention of mentions) {
    text = text.replace(new RegExp(`@${mention}\\b`, "g"), "").trim();
  }
  return text;
}

// ── Plugin definition ────────────────────────────────────────────────────────

export const agentchatPlugin = createChatChannelPlugin({
  base: {
    id: PLUGIN_ID,
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
      isConfigured: (account: ResolvedAgentChatAccount) => {
        const { serverUrl, username, password } = account.config;
        return (
          typeof serverUrl === "string" &&
          serverUrl.length > 0 &&
          isValidUrl(serverUrl) &&
          typeof username === "string" &&
          username.length > 0 &&
          typeof password === "string" &&
          password.length > 0
        );
      },
      unconfiguredReason: () =>
        "AgentChat account not configured (valid serverUrl, username, password required)",
      describeAccount: (account: ResolvedAgentChatAccount) => ({
        accountId: account.accountId,
        status: account.enabled ? "active" : "disabled",
        summary: {
          serverUrl: account.config.serverUrl,
          username: account.config.username,
        },
      }),
      disabledReason: (account: ResolvedAgentChatAccount) =>
        account.enabled ? undefined : "Account is disabled",
    },

    configSchema: AgentChatConfigSchema,

    // ── Outbound ─────────────────────────────────────────────────────────────
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }: { to?: string }) => {
        if (!to) {return { ok: false, error: new Error("No target specified") };}
        return { ok: true, to };
      },
      sendText: async ({ cfg, accountId, to, text, replyToId, identity }: { cfg: OpenClawConfig, accountId: string, to: string, text: string, replyToId?: string, identity?: unknown }) => {
        const account = resolveAgentChatAccount(cfg, accountId);
        const client = getWsClient();

        if (!client.isConnected()) {
          await client.connect(account.config);
          // Attach runtime handlers after connecting
          client.onMessage(makeOnMessageHandler(globalRuntime, accountId));
          client.onError((err) =>
            globalRuntime?.error?.(`[agentchat] WS error: ${err.message}`)
          );
        }

        // Parse target: "group:{id}" or "user:{id}"
        const isGroup = to.startsWith("group:");
        const targetId = to.replace(/^(group:|user:)/, "");

        // Send with flat structure (no extra "payload" wrapper)
        client.send({
          type: "send_text",
          content: text,
          groupId: isGroup ? targetId : undefined,
          recipientId: !isGroup ? targetId : undefined,
          replyTo: replyToId ? Number(replyToId) : undefined,
        } as unknown);

        return [{ delivered: true, messageId: `local_${Date.now()}` }];
      },
    },

    // ── Messaging (inbound routing) ──────────────────────────────────────────
    messaging: {
      normalizeTarget: (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) {return undefined;}
        return trimmed.replace(/^agentchat:/i, "");
      },
      targetResolver: {
        looksLikeId: (id: string | null | undefined) => /^\d+$/.test(id ?? ""),
        hint: "<groupId|userId>",
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

export function setAgentChatRuntime(runtime: unknown): void {
  globalRuntime = runtime;
  if (globalWsClient) {
    globalWsClient.onMessage(makeOnMessageHandler(runtime, DEFAULT_ACCOUNT_ID));
    globalWsClient.onError((err) =>
      runtime.error?.(`[agentchat] WS error: ${err.message}`)
    );
  }
}

// ── Bootstrap: connect WS when plugin starts ─────────────────────────────────

export function startAgentChatClient(cfg: OpenClawConfig): void {
  const accountIds = listAgentChatAccountIds(cfg);
  for (const accountId of accountIds) {
    const account = resolveAgentChatAccount(cfg, accountId);
    if (!account.enabled) {continue;}

    const client = getWsClient();
    client.onMessage(makeOnMessageHandler(globalRuntime, accountId));
    client.onError((err) => {
      globalRuntime?.error?.(`[agentchat] WS error: ${err.message}`);
    });

    client.connect(account.config).catch((err) => {
      globalRuntime?.error?.(`[agentchat] connect failed: ${err}`);
    });
  }
}
