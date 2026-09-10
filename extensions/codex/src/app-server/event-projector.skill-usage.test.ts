import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  createParams,
  createProjector,
  forCurrentTurn,
  flushDiagnosticEvents,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("Codex native successful skill accounting", () => {
  it.each([
    { status: "completed", exitCode: 0, expected: 1 },
    { status: "completed", exitCode: 1, expected: 0 },
    { status: "failed", exitCode: 1, expected: 0 },
    { status: "declined", exitCode: null, expected: 0 },
    { status: "inProgress", exitCode: null, expected: 0 },
    { status: "completed", exitCode: null, expected: 0 },
  ])(
    "native skill result $status/$exitCode is counted only once when successful",
    async ({ status, exitCode, expected }) => {
      const params = await createParams();
      const skillFile = `${params.workspaceDir}/skills/native/SKILL.md`;
      const projector = await createProjector(params, {
        nativeSkillUsageContext: {
          runId: params.runId,
          agentId: "fixture",
          cwd: params.workspaceDir,
          workspaceDir: params.workspaceDir,
          skillUsagePaths: [
            { readPath: skillFile, skillFile, skillName: "native", skillSource: "workspace" },
          ],
        },
      });
      const events: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((e) => events.push(e));
      try {
        const notification = forCurrentTurn("item/completed", {
          item: {
            type: "commandExecution",
            id: "same-native-id",
            command: `cat ${skillFile}`,
            cwd: params.workspaceDir,
            status,
            exitCode,
            commandActions: [],
            aggregatedOutput: "",
            durationMs: 1,
          },
        });
        await projector.handleNotification(notification);
        await projector.handleNotification(notification);
        await flushDiagnosticEvents();
        expect(events.filter((e) => e.type === "skill.used")).toHaveLength(expected);
      } finally {
        unsubscribe();
      }
    },
  );
});
