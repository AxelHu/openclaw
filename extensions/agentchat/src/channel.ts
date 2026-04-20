// ============================================================================
// AgentChat Channel Plugin
// ============================================================================

import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import type {
  AgentChatConfig,
  ServerMessage,
} from "./types.js";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/core";
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
  const client = getWsClient();
  const myUserId = client.getUserId();
  return (msg: ServerMessage) => {
    // Server sends flat messages: { type: "message", eventId, groupId, ... }
    // The payload IS the message object itself
    const payload = (msg as any).payload ?? msg;
    if (msg.type === "message") {
      void handleIncomingMessage(runtime, accountId, myUserId, payload as unknown);
    } else if (msg.type === "invite_notification") {
      void handleInviteNotification(runtime, accountId, payload as unknown);
    }
  };
}

async function handleIncomingMessage(
  runtime: unknown,
  accountId: string,
  myUserId: string,
  payload: unknown
) {
  // Payload IS the MessageObject (no extra "event" wrapper at this level)
  const eventId = payload.event_id ?? payload.eventId ?? "";
  const groupId = String(payload.group_id ?? payload.groupId ?? "");
  const userId = String(payload.sender_id ?? payload.userId ?? "");
  const username = payload.sender_name ?? payload.username ?? "";
  const receiverId = String(payload.receiver_id ?? payload.receiverId ?? "");
  const receiverName = String(payload.receiver_name ?? payload.receiverName ?? "");
  const groupName = String(payload.group_name ?? payload.groupName ?? "");
  const content = payload.content ?? "";
  const _createdAt = payload.created_at ?? payload.createdAt ?? "";

  // Detect chat type: private chat has no groupId but has receiverId
  const isPrivate = !groupId && receiverId;

  // Build session key: private = agentchat:user:<receiverId>, group = agentchat:group:<groupId>
  // For private chat, use receiverId as session key so each recipient routes to their own session
  const sessionKey = isPrivate
    ? `agentchat:user:${receiverId}`
    : `agentchat:group:${groupId}`;

  // Use Feishu's structured mentions array [{userId, offset, length, name}]
  // wasMentioned = true only if this agent's own userId appears in the mentions list
  const mentions: any[] = (payload as any).mentions ?? [];
  const wasMentioned = mentions.some((m) => m.userId === myUserId);
  // Preserve <at> tags in text so OpenClaw agent can see them
  let text = content;

  // Prepend message header for context (group name / private chat indicator)
  // Use ac_ prefix for sender/receiver IDs (similar to Feishu's ou_ format)
  if (isPrivate) {
    const acSenderId = `ac_${userId}`;
    const acReceiverId = `ac_${receiverId}`;
    const senderLabel = username ? `${username}(${acSenderId})` : acSenderId;
    const receiverLabel = receiverName || acReceiverId;
    text = `[私聊 | ${senderLabel} → ${receiverLabel}]: ${text}`;
  } else if (groupId) {
    const groupLabel = groupName || groupId;
    text = `[群聊 | ${groupLabel}]: ${text}`;
  }

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
      sendText: async ({ cfg, accountId, to, text, replyToId }: { cfg: OpenClawConfig, accountId: string, to: string, text: string, replyToId?: string }) => {
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

  // ── Gateway adapter (keeps channel "running" while WS is connected) ─────────
  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedAgentChatAccount>) => {
      const cfg = ctx.cfg as OpenClawConfig;
      const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
      const account = resolveAgentChatAccount(cfg, accountId);
      if (!account.enabled) {return;}

      const startTime = Date.now();
      console.error("[AgentChat] gateway.startAccount ENTRY at", startTime, "signal.aborted=", ctx.abortSignal.aborted);

      // Report running (not yet connected)
      ctx.setStatus({
        accountId,
        enabled: true,
        configured: true,
        running: true,
        connected: false,
        restartPending: false,
        lastStartAt: Date.now(),
        lastError: null,
      });

      const client = getWsClient();
      client.onMessage(makeOnMessageHandler(ctx.runtime, accountId));
      client.onError((err) => {
        ctx.runtime.error?.(`[agentchat] WS error: ${err.message}`);
        ctx.setStatus({ accountId, lastError: err.message });
      });

      // If already connected, just update status
      if (client.isConnected()) {
        console.error("[AgentChat] startAccount: already connected at", Date.now(), "diff="+(Date.now()-startTime)+"ms");
        ctx.setStatus({ accountId, connected: true });
        // Wait for abort without reconnecting
        await new Promise((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => {
            console.error("[AgentChat] startAccount ABORTED at", Date.now(), "diff="+(Date.now()-startTime)+"ms");
            resolve(undefined);
          }, { once: true });
        });
        console.error("[AgentChat] startAccount EXIT (abort) at", Date.now(), "diff="+(Date.now()-startTime)+"ms");
        return;
      }

      // Connect and stay alive
      try {
        console.error("[AgentChat] startAccount: connecting at", Date.now(), "diff="+(Date.now()-startTime)+"ms");
        await client.connect(account.config);
        ctx.setStatus({ accountId, connected: true });
        console.error("[AgentChat] startAccount: connected at", Date.now(), "diff="+(Date.now()-startTime)+"ms, waiting for abort...");

        // Keep running until abort
        await new Promise((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => {
            console.error("[AgentChat] startAccount ABORTED at", Date.now(), "diff="+(Date.now()-startTime)+"ms");
            resolve(undefined);
          }, { once: true });
        });
      } catch (err: unknown) {
        console.error("[AgentChat] startAccount ERROR:", (err as Error)?.message ?? String(err));
        ctx.setStatus({ accountId, lastError: err?.message ?? String(err), connected: false });
        throw err;
      } finally {
        console.error("[AgentChat] startAccount FINALLY at", Date.now(), "diff="+(Date.now()-startTime)+"ms");
        ctx.setStatus({ accountId, running: false, connected: false });
      }
    },
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
  if (getWsClient().isConnected()) {
    console.error("[AgentChat] startAgentChatClient SKIPPED (already connected)");
    return;
  }
  console.error("[AgentChat] startAgentChatClient called, accounts:", JSON.stringify(Object.keys(cfg?.channels ?? {})));
  const accountIds = listAgentChatAccountIds(cfg);
  for (const accountId of accountIds) {
    const account = resolveAgentChatAccount(cfg, accountId);
    if (!account.enabled) {continue;}

    const client = getWsClient();
    client.onMessage((msg) => makeOnMessageHandler(globalRuntime, accountId)(msg));
    client.onError((err) => {
      globalRuntime?.error?.(`[agentchat] WS error: ${err.message}`);
    });

    client.connect(account.config).catch((err) => {
      globalRuntime?.error?.(`[agentchat] connect failed: ${err}`);
    });
  }
}
