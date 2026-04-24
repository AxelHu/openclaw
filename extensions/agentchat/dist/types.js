// ============================================================================
// AgentChat WebSocket Protocol Types
// Based on agentchat-design.md §5 WebSocket Protocol
// ============================================================================
// ---------------------------------------------------------------------------
// Utility: type-safe WSMessage constructor helpers
// ---------------------------------------------------------------------------
export function makeWSMessage(type, payload, seq) {
    return {
        type,
        payload,
        timestamp: Date.now(),
        ...(seq !== undefined && { seq }),
    };
}
//# sourceMappingURL=types.js.map