/** Stable identity passed from an OpenClaw agent run to child processes. */
export function buildAgentSubprocessEnv(params: {
  agentId?: string;
  workspaceDir?: string;
}): Record<string, string> {
  const agentId = params.agentId?.trim();
  const workspaceDir = params.workspaceDir?.trim();
  return {
    ...(agentId ? { OPENCLAW_AGENT_ID: agentId } : {}),
    ...(workspaceDir ? { OPENCLAW_AGENT_WORKSPACE: workspaceDir } : {}),
  };
}
