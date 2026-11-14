import {
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { rotateOversizedCodexAppServerStartupBinding as rotateStartupBindingImpl } from "./startup-binding.js";

export function resolveCodexAppServerStartupBinding(
  params: Omit<Parameters<typeof rotateStartupBindingImpl>[0], "bindingStore" | "identity">,
) {
  return rotateStartupBindingImpl({
    ...params,
    bindingStore: testCodexAppServerBindingStore,
    identity: { kind: "session", agentId: "main", sessionId: params.sessionFile },
  });
}

export async function rotateOversizedCodexAppServerStartupBinding(
  params: Omit<Parameters<typeof rotateStartupBindingImpl>[0], "bindingStore" | "identity">,
) {
  return (await resolveCodexAppServerStartupBinding(params)).binding;
}

export async function writeExistingBinding(
  sessionFile: string,
  workspaceDir: string,
  overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
) {
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "fixture-model",
    modelProvider: "openai",
    ...overrides,
  });
}
