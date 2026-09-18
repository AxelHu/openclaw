/**
 * Codex registry features that OpenClaw's ring-zero harness must fail closed.
 *
 * Re-audit this list when the managed Codex app-server version changes: each
 * entry can expose a model-visible tool or host execution capability.
 */
export const CODEX_RING_ZERO_RESTRICTED_FEATURES = new Set([
  "apps",
  "artifact",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_only",
  "codex_apps_mcp_2026_07_28",
  "computer_use",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "skill_search",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "unified_exec",
  "unified_exec_tty",
  "view_image",
  "web_search_cached",
  "web_search_request",
  "windows_sandbox_service",
  "worktrees",
  "workspace_dependencies",
]);

export const CODEX_RING_ZERO_RESTRICTED_FEATURE_ALIASES = new Map<string, string>([
  ["connectors", "apps"],
  ["imagegenext", "image_generation"],
  ["collab", "multi_agent"],
  ["memory_tool", "memories"],
  ["telepathy", "chronicle"],
  ["codex_hooks", "hooks"],
]);
