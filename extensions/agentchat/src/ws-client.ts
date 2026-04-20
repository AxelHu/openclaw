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

  async connect(config: AgentChatConfig): Promise<void> {
    // If already connected with the same config, skip
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    // Close any existing stale connection before reconnecting
    if (this.ws) {
      this.ws.close(1001, "Reconnecting");
    }
    this.config = config;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    if (!this.config) {throw new Error("No config");}

    // ── 1. Login via REST to get JWT ─────────────────────────────────────────
    const loginUrl = `${this.config.restUrl}/api/auth/login`;
    let loginRes: Response;
    try {
      loginRes = await Promise.race([
        fetch(loginUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: this.config.username, password: this.config.password }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("fetch timeout 10s")), 10000)),
      ]);
    } catch (err) {
      this.errorHandler?.(new Error(`Login request failed: ${String(err)}`));
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
    const wsUrl = `${this.config.serverUrl}?token=${encodeURIComponent(this.token)}`;
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.errorHandler?.(new Error(`WebSocket construction failed: ${String(err)}`));
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.startPing();
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data)) as ServerMessage;
        if (msg.type === "connected") {return;} // Server confirmed connection
        this.messageHandler?.(msg);
      } catch (err) {
        this.errorHandler?.(new Error(`Failed to parse WS message: ${String(err)}`));
      }
    });

    this.ws.on("close", (code, _reason) => {
      this.connected = false;
      this.stopPing();
      if (!this.intentionalClose) {
        this.errorHandler?.(new Error(`WS closed (code=${code})`));
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
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
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setMessageHandler(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  setErrorHandler(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {return false;}
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.close(1000, "Client closing");
      this.ws.on("close", () => resolve(), { once: true });
      // Safety timeout
      setTimeout(resolve, 3000);
    });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createWSClient(): WSClient {
  return new AgentChatWSClientImpl();
}
