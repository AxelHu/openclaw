import { createHash } from "node:crypto";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
} from "./session-binding.js";

// Client-authored developer supplements must survive native context compaction.
// Introduced in Codex 0.153.4 and reverified in 0.155.0; it adds no model tool or permission surface.
export const CODEX_RETAIN_HOST_CONTEXT_CONFIG = {
  "features.retain_client_developer_messages": true,
};

export type CodexTurnSupplementalInstructions = {
  turnScopedDeveloperInstructions?: string;
  skillsDeveloperInstructions?: string;
  memoryDeveloperInstructions?: string;
};

/** OpenClaw owns these supplements; Codex owns its collaboration-mode instructions. */
export function buildCodexTurnSupplementalInstructions(
  params: Pick<EmbeddedRunAttemptParams, "trigger">,
  options: CodexTurnSupplementalInstructions,
): string {
  const sections = [
    params.trigger === "cron" ? buildCronInstructions() : undefined,
    options.turnScopedDeveloperInstructions,
    options.memoryDeveloperInstructions,
    options.skillsDeveloperInstructions,
  ].filter((section): section is string => Boolean(section?.trim()));
  const body = sections.join("\n\n");
  const revision = createHash("sha256").update(body).digest("hex");
  return [
    `<openclaw_turn_context revision="${revision}">`,
    "This is the complete current OpenClaw supplemental context, not a delta.",
    "It replaces earlier OpenClaw turn-specific SOUL/IDENTITY, Memory Recall, Skills catalog, and cron supplements, including supplements previously carried in collaboration-mode messages.",
    "Only the latest complete snapshot is active. Omitted sections are empty; do not retain removed skills or obsolete instructions from older snapshots.",
    "This snapshot does not replace Codex native mode instructions, base instructions, project instructions, tools, permissions, or the current user request.",
    body || "There are no OpenClaw turn-specific supplements for this turn.",
    "</openclaw_turn_context>",
  ].join("\n\n");
}

function buildCronInstructions(): string {
  return [
    "This is an OpenClaw cron automation turn. Apply these instructions only to this scheduled job; they do not change the native collaboration mode.",
    "Execute the cron payload directly. If it asks you to run an exact command, run that command before doing any investigation, planning, memory review, or workspace bootstrap.",
    "Use context already provided by the runtime, but do not spend time loading or re-reading workspace bootstrap, memory, or project-doc files before executing the cron payload. Inspect those files only if the payload asks for them or the command fails and they are needed to diagnose it.",
    "Keep output concise and automation-oriented. Prefer the final command result or a short failure summary over status narration.",
  ].join("\n\n");
}

/**
 * Synchronize before turn/start while the caller owns the idle thread route.
 * Codex 0.153.4 introduced thread/inject_items for complete developer ResponseItems; reverified in 0.155.0;
 * additionalContext instead truncates each value at 1,000 estimated tokens.
 *
 * A receipt in the existing binding store survives native and gateway restarts.
 * This is append-with-supersession, NOT historical deletion or an exactly-once
 * protocol. Never retry an indeterminate RPC here or save an unacknowledged hash.
 */
export async function injectCodexTurnSupplementalInstructions(params: {
  client: CodexAppServerClient;
  threadId: string;
  bindingStore: CodexAppServerBindingStore;
  bindingIdentity: CodexAppServerBindingIdentity;
  instructions: string;
  timeoutMs: number;
  signal?: AbortSignal;
  transient?: boolean;
}): Promise<void> {
  const binding = await params.bindingStore.read(params.bindingIdentity);
  if (!params.transient && binding?.threadId !== params.threadId) {
    throw new Error("Codex supplemental context lost its native thread binding");
  }
  const fingerprint = createHash("sha256").update(params.instructions).digest("hex");
  if (!params.transient && binding?.supplementalContextFingerprint === fingerprint) {
    return;
  }
  await params.client.request(
    "thread/inject_items",
    {
      threadId: params.threadId,
      items: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: params.instructions }],
        },
      ],
    },
    { timeoutMs: params.timeoutMs, signal: params.signal },
  );
  // An explicitly transient native thread must not mutate the preserved session binding.
  if (params.transient) {
    return;
  }
  // Persist the acknowledgement even if the following user turn is cancelled.
  // The thread-id fence cannot stamp a concurrently replaced native binding.
  const saved = await params.bindingStore.mutate(params.bindingIdentity, {
    kind: "patch",
    threadId: params.threadId,
    patch: { supplementalContextFingerprint: fingerprint },
  });
  if (!saved) {
    throw new Error("Codex supplemental context acknowledgement lost its thread binding");
  }
}
