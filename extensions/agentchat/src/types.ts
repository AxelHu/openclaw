// ============================================================================
// AgentChat WebSocket Protocol Types
// Based on agentchat-design.md §5 WebSocket Protocol
// ============================================================================

// ---------------------------------------------------------------------------
// Client → Server Messages (5.3)
// ---------------------------------------------------------------------------

/** Outgoing send_text uses a FLAT structure (no payload wrapper) — matches §5.3 protocol */
export interface SendTextClientMessage {
  type: "send_text";
  content: string;
  groupId?: string;
  recipientId?: string;
  replyTo?: number;
  readers?: number[];
}

/** Payload for subscribe / unsubscribe */
export interface GroupSubscriptionPayload {
  groupId: number;
}

/** Payload for sync */
export interface SyncPayload {
  since?: number;
}

/** Payload for invite */
export interface InvitePayload {
  groupId: number;
  username: string;
}

/** Payload for invite_accept / invite_reject */
export interface InviteResponsePayload {
  groupId: number;
}

/** Profile fields the agent can update */
export interface ProfileSettings {
  displayName?: string;
  avatarUrl?: string;
  notify_dm?: boolean;
  notify_group?: boolean;
  notify_mention?: boolean;
}

/** Payload for set_profile */
export interface SetProfilePayload extends ProfileSettings {}

/** Payload for set_managers */
export interface SetManagersPayload {
  managers: Array<{ id: number; can_edit_settings?: boolean; can_invite_groups?: boolean }>;
}

/** Outgoing client message discriminated by type */
export type ClientMessage =
  | SendTextClientMessage
  | WSMessage<"subscribe", GroupSubscriptionPayload>
  | WSMessage<"unsubscribe", GroupSubscriptionPayload>
  | WSMessage<"sync", SyncPayload>
  | WSMessage<"invite", InvitePayload>
  | WSMessage<"invite_accept", InviteResponsePayload>
  | WSMessage<"invite_reject", InviteResponsePayload>
  | WSMessage<"set_profile", SetProfilePayload>
  | WSMessage<"set_managers", SetManagersPayload>;

// ---------------------------------------------------------------------------
// Server → Client Messages (5.4)
// ---------------------------------------------------------------------------

/** Incoming server message discriminated by type */
export type ServerMessage =
  | WSMessage<"connected", ConnectedPayload>
  | WSMessage<"message", MessagePayload>
  | WSMessage<"invite_notification", InviteNotificationPayload>
  | WSMessage<"group_joined", GroupJoinedPayload>
  | WSMessage<"sync_result", SyncResultPayload>
  | WSMessage<"error", ErrorPayload>
  | WSMessage<"pong", Record<string, never>>;

// ---------------------------------------------------------------------------
// Shared Payload Types
// ---------------------------------------------------------------------------

/** Sent by server immediately after connection (5.1) */
export interface ConnectedPayload {
  userId: number;
  username: string;
}

/** Message event object (5.5) */
export interface MessageObject {
  event_id: string;
  sender_id: number;
  sender_name: string;
  group_id: number | null;
  recipient_id: number | null;
  msg_type: "text" | "image" | "file" | "system";
  content: string;
  reply_to: MessageObject | null;
  readers: number[] | null; // null = visible to everyone
  seq_in_room: number | null;
  created_at: string; // ISO 8601
}

export interface MessagePayload {
  event: MessageObject;
}

export interface InviteObject {
  id: number;
  group_id: number;
  inviter_id: number;
  inviter_name: string;
  group_name: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}

export interface InviteNotificationPayload {
  invite: InviteObject;
}

export interface GroupObject {
  id: number;
  name: string;
  description: string;
  avatar_url: string;
  is_private: boolean;
  created_by: number;
  created_at: string;
}

export interface GroupJoinedPayload {
  group: GroupObject;
}

export interface SyncResultPayload {
  events: MessageObject[];
  cursor: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  seq?: number;
}

// ---------------------------------------------------------------------------
// Internal / Helper Types
// ---------------------------------------------------------------------------

/** AgentChat connection configuration */
export interface AgentChatConfig {
  serverUrl: string;   // e.g. "wss://your-server.com/ws"
  restUrl: string;      // e.g. "https://your-server.com/api"
  username: string;
  password: string;     // or "env:AGENTCHAT_PASSWORD"
}

/** Represents an active WS connection */
export interface WSClient {
  connect(config: AgentChatConfig): Promise<void>;
  disconnect(): void;
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onError(handler: (err: Error) => void): void;
  isConnected(): boolean;
  getUserId(): string | null;
}

// ---------------------------------------------------------------------------
// Utility: type-safe WSMessage constructor helpers
// ---------------------------------------------------------------------------

export function makeWSMessage<T extends string, P>(
  type: T,
  payload: P,
  seq?: number
): WSMessage<T, P> {
  return {
    type,
    payload,
    timestamp: Date.now(),
    ...(seq !== undefined && { seq }),
  };
}

// Type alias for convenience
export type WSMessage<T extends string = string, P = unknown> = {
  type: T;
  seq?: number;
  payload: P;
  timestamp: number;
};
