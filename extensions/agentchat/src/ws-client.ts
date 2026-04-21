// ============================================================================
// AgentChat WebSocket Client
// Auto-reconnect with exponential backoff, JWT auth, heartbeat
// ============================================================================

/// <reference types="node" />

import WebSocket from "ws";
import type {
  AgentChatConfig,
  ClientMessage,
  ServerMessage,
  WSClient,
} from "./types.js";

// Node.js globals for timers and fetch
const setTimeout = globalThis.setTimeout.bind(globalThis);
const setInterval = globalThis.setInterval.bind(globalThis);
const clearTimeout = globalThis.clearTimeout.bind(globalThis);
const clearInterval = globalThis.clearInterval.bind(globalThis);

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;

export class AgentChatWSClientImpl implements WSClient {
  private ws: WebSocket | null = null;
  private config: AgentChatConfig | null = null;
  private token: string | null = null;
  private messageHandler: ((msg: ServerMessage) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private connected = false;
  private connId = 0; // Increments on each connect, used to ignore stale callbacks
  private connecting = false; // Prevents concurrent doConnect() calls
  private userId: string | null = null; // Server-assigned userId

  async connect(config: AgentChatConfig): Promise<void> {
    this.config = config;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    if (this.connecting) {return;}
    this.connecting = true;
    try {
      await this.doConnect();
    } finally {
      this.connecting = false;
    }
  }

  private async doConnect(): Promise<void> {
    if (!this.config) {throw new Error("No config");}
    // If a WS already exists and is alive, clean it up first before creating a new one
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      const oldWs = this.ws;
      this.ws = undefined;
      // Prevent old WS's close/error handlers from firing after we setup new ones
      const oldOnClose = oldWs.onclose;
      const oldOnError = oldWs.onerror;
      oldWs.onclose = null as any;
      oldWs.onerror = null as any;
      oldWs.close();
      // Also update connId so any late callbacks from old WS are ignored
      ++this.connId;
    }

    // ── 1. Login via REST to get JWT ─────────────────────────────────────────
    const loginUrl = `${this.config.restUrl}/api/auth/login`;
    let loginRes: Response;
    try {
      loginRes = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: this.config.username, password: this.config.password }),
      });
    } catch (err) {
      this.errorHandler?.(new Error(`Login request failed: ${err}`));
      this.scheduleReconnect();
      return;
    }

    if (!loginRes.ok) {
      const body = await loginRes.text().catch(() => "");
      this.errorHandler?.(new Error(`Login failed (${loginRes.status}): ${body}`));
      this.scheduleReconnect();
      return;
    }

    let loginData: { token?: string; userId?: string };
    try {
      loginData = await loginRes.json();
    } catch {
      this.errorHandler?.(new Error("Login response invalid JSON"));
      this.scheduleReconnect();
      return;
    }

    if (!loginData.token) {
      this.errorHandler?.(new Error("Login response missing token"));
      this.scheduleReconnect();
      return;
    }

    this.token = loginData.token;

    // ── 2. Open WebSocket ────────────────────────────────────────────────────
    // Increment connId so stale callbacks from old connections are ignored
    const myConnId = ++this.connId;
    const wsUrl = `${this.config.serverUrl}?token=${encodeURIComponent(this.token)}`;
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.errorHandler?.(new Error(`WebSocket construction failed: ${err}`));
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.startPing();
    });

    this.ws.on("message", (data) => {
      const rawStr = String(data);
      console.log("[AgentChat] MSG IN raw_len="+rawStr.length+",state="+this.ws.readyState+", t="+Date.now()+" raw=" + rawStr.slice(0,100));
      // Skip new messages when we're being replaced (only handle graceful shutdown messages)
      if ((this as any).isReplacing) {return;}
      try {
        const msg = JSON.parse(rawStr) as ServerMessage;
        if (msg.type === "connected") {
          this.userId = (msg as any).userId ?? null;
          // Server confirmed connection — send identify to register as agent
          if (this.config?.agentId) {
            this.ws.send(JSON.stringify({ type: "identify", agentId: this.config.agentId }));
          }
          return;
        }
        if (msg.type === "identified") {
          console.log(`[AgentChat] identified as agent: ${msg.agentId}`);
          return;
        }
        if (msg.type === "replace") {
          // Graceful replace: stop accepting new messages, finish pending, then close
          console.log(`[AgentChat] received replace, closing gracefully`);
          (this as any).isReplacing = true;
          // Notify server that we're about to close
          try {
            this.ws.send(JSON.stringify({ type: "replace_ack" }));
          } catch {}
          // Wait a bit for any in-flight messages to complete, then close
          setTimeout(() => {
            if (this.ws) {
              this.intentionalClose = true;
              this.ws.close(4001, "replaced");
            }
          }, 500);
          return;
        }
        if (msg.type === "agent_message") {
          // Forward to message handler for routing to agent session
          this.messageHandler?.(msg);
          return;
        }
        this.messageHandler?.(msg);
      } catch (err) {
        this.errorHandler?.(new Error(`Failed to parse WS message: ${err}`));
      }
    });

    this.ws.on("close", (code, reason) => {
      this.connected = false;
      this.stopPing();
      // Ignore if a newer connection has been established
      if (myConnId !== this.connId) {return;}
      if (!this.intentionalClose) {
        this.errorHandler?.(new Error(`WS closed (code=${code})`));
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      // Ignore errors from stale connections
      if (myConnId !== this.connId) {return;}
      this.errorHandler?.(new Error(`WS error: ${err}`));
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) {return;}
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {/* already handled in doConnect */});
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.token = null;
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("AgentChatWSClient is not connected");
    }
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getUserId(): string | null {
    return this.userId;
  }
}

export function createWSClient(): WSClient {
  return new AgentChatWSClientImpl();
}
