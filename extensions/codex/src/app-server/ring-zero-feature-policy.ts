/**
 * Codex registry features that OpenClaw's ring-zero harness must fail closed.
 *
 * Audited against Codex 0.169.0 features and native tool registration. Re-audit
 * this list when the managed Codex app-server version changes: each
 * entry can expose a model-visible tool or host execution capability.
 */
export const CODEX_RING_ZERO_RESTRICTED_FEATURES = new Set([
  "agent_message_board",
  "agent_message_board_mcp",
  "apps",
  "artifact",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_only",
  "code_mode_tool_search",
  "codex_apps_mcp_2026_07_28",
  "computer_use",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "enable_mcp_apps",
  "external_agent_memory_import",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "multi_env_copy_file",
  "plugins",
  "request_permissions_tool",
  "send_message_to_user_async",
  "skill_mcp_dependency_install",
  "skill_search",
  "shell_tool",
  "sleep_tool",
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
