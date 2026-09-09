import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { codexSandboxPolicyForTurn, type CodexAppServerRuntimeOptions } from "./config.js";
import type {
  CodexSandboxPolicy,
  CodexTurnEnvironmentParams,
  CodexTurnStartParams,
  CodexUserInput,
} from "./protocol.js";
import { readCodexSupportedReasoningEfforts } from "./reasoning-effort.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerRequestModelSelection,
  resolveReasoningEffort,
} from "./thread-model-selection.js";
import { buildCodexUserInput } from "./user-input.js";

const CODEX_CURRENT_SENDER_FIELD_MAX_CHARS = 256;

function buildCodexCurrentSenderContextValue(params: EmbeddedRunAttemptParams): string | undefined {
  const metadata = asOptionalRecord(
    asOptionalRecord(params.userTurnTranscriptRecorder?.message as unknown)?.["__openclaw"],
  );
  const recorded = [
    normalizeOptionalString(metadata?.["senderId"]),
    normalizeOptionalString(metadata?.["senderName"]),
    normalizeOptionalString(metadata?.["senderUsername"]),
  ] as const;
  const [id, name, username] = recorded.some(Boolean)
    ? recorded
    : [
        normalizeOptionalString(params.senderId),
        normalizeOptionalString(params.senderName),
        normalizeOptionalString(params.senderUsername),
      ];
  if (!id && !name && !username) {
    return undefined;
  }
  const bound = (value: string) => truncateUtf16Safe(value, CODEX_CURRENT_SENDER_FIELD_MAX_CHARS);
  return JSON.stringify({
    sender: {
      ...(id ? { id: bound(id) } : {}),
      ...(name ? { name: bound(name) } : {}),
      ...(username ? { username: bound(username) } : {}),
    },
  });
}

export function buildTurnStartParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    cwd: string;
    appServer: CodexAppServerRuntimeOptions;
    promptText?: string;
    explicitSkillInputs?: Array<Extract<CodexUserInput, { type: "skill" }>>;
    sandboxPolicy?: CodexSandboxPolicy;
    environmentSelection?: CodexTurnEnvironmentParams[];
    model?: string | null;
    modelProvider?: string | null;
    preserveNativeTurnSettings?: boolean;
    clearInheritedServiceTier?: boolean;
  },
): CodexTurnStartParams {
  const modelSelection = options.preserveNativeTurnSettings
    ? undefined
    : resolveCodexAppServerRequestModelSelection({
        model: options.model ?? params.modelId,
        modelProvider: options.modelProvider,
        authProfileId: params.authProfileId,
        authProfileStore: params.authProfileStore,
        agentDir: params.agentDir,
        config: params.config,
      });
  const useThreadPermissionProfile = options.appServer.networkProxy && !options.sandboxPolicy;
  const currentSenderContext =
    params.trigger === "user" ? buildCodexCurrentSenderContextValue(params) : undefined;
  // Untrusted context exposes authenticated attribution without promoting human-controlled labels.
  let additionalContext: CodexTurnStartParams["additionalContext"] = currentSenderContext
    ? { openclaw_current_sender: { kind: "untrusted", value: currentSenderContext } }
    : undefined;
  if (params.permissionChange?.notice) {
    // Application context is a developer message in Codex 0.151.0 and also
    // reaches native-preserved threads without overriding their turn settings.
    additionalContext = {
      ...additionalContext,
      openclaw_permission_change: { kind: "application", value: params.permissionChange.notice },
    };
  }
  return {
    threadId: options.threadId,
    // codex-rs/app-server-protocol/src/protocol/v2/turn.rs:292-324 at 91d6f48992ad defines
    // UserInput::Skill; skills/src/selection.rs:60-92 blocks those names from duplicate text
    // selection while leaving unmatched Codex-native-only names scannable.
    input: [
      ...buildCodexUserInput(options.promptText ?? params.prompt, params.images),
      ...(options.explicitSkillInputs ?? []),
    ],
    ...(additionalContext ? { additionalContext } : {}),
    cwd: options.cwd,
    ...(options.appServer.sessionRoot
      ? { runtimeWorkspaceRoots: [options.appServer.sessionRoot] }
      : {}),
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    ...(useThreadPermissionProfile
      ? {}
      : {
          sandboxPolicy:
            options.sandboxPolicy ??
            codexSandboxPolicyForTurn(
              options.appServer.sandbox,
              options.appServer.sessionRoot ?? options.cwd,
              options.appServer.start?.args,
            ),
        }),
    ...(modelSelection
      ? { model: modelSelection.model, personality: CODEX_NATIVE_PERSONALITY_NONE }
      : {}),
    // Codex distinguishes an omitted native default from explicitly clearing
    // an OpenClaw-owned priority override left on this exact warm session.
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : options.clearInheritedServiceTier
        ? { serviceTier: null }
        : {}),
    ...(modelSelection
      ? {
          effort: resolveReasoningEffort(
            params.thinkLevel,
            modelSelection.model,
            readCodexSupportedReasoningEfforts(params.model?.compat),
          ),
        }
      : {}),
    ...(options.environmentSelection ? { environments: options.environmentSelection } : {}),
    ...(modelSelection
      ? {
          collaborationMode: buildTurnCollaborationMode(params, {
            model: modelSelection.model,
          }),
        }
      : {}),
  };
}

type CodexTurnCollaborationMode = NonNullable<CodexTurnStartParams["collaborationMode"]>;

export function buildTurnCollaborationMode(
  params: EmbeddedRunAttemptParams,
  options: {
    model?: string;
  } = {},
): CodexTurnCollaborationMode {
  const model = options.model ?? params.modelId;
  return {
    mode: "default",
    settings: {
      model,
      reasoning_effort: resolveReasoningEffort(
        params.thinkLevel,
        model,
        readCodexSupportedReasoningEfforts(params.model?.compat),
      ),
      developer_instructions: null,
    },
  };
}
