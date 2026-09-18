import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createStdioTransport } from "./transport-stdio.js";
import {
  buildCodexTurnSupplementalInstructions,
  injectCodexTurnSupplementalInstructions,
} from "./turn-instructions.js";
import { buildTurnStartParams } from "./turn-params.js";
import { createCodexUserInputTestParams } from "./user-input-bridge.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

// This provider fixture replaces only model responses. The installed Codex binary
// constructs every captured HTTP request, including catalog mode selection.
const MODEL_CATALOG = {
  models: [
    {
      slug: "context-probe-model",
      display_name: "Context fixture",
      description: "Synthetic protocol test model",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        {
          effort: "low",
          description: "Fixture",
        },
      ],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      context_window: 200000,
      max_context_window: 200000,
      truncation_policy: {
        mode: "tokens",
        limit: 10000,
      },
      supports_parallel_tool_calls: true,
      input_modalities: ["text"],
      model_messages: {
        instructions_template: "MODEL_BASE_MARKER",
        collaboration_modes: {
          default: "CATALOG_DEFAULT_MARKER",
          plan: "CATALOG_PLAN_MARKER",
        },
      },
      prefer_websockets: false,
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      supports_image_detail_original: true,
      multi_agent_version: "v1",
      multi_agent_reasoning_effort: "xhigh",
      use_responses_lite: false,
      include_skills_usage_instructions: false,
      include_apps_usage_instructions: false,
      include_plugin_usage_instructions: false,
      node_repl_auto_review_required: false,
      node_repl_disabled: false,
      requires_sandboxed_review: false,
      auto_review_model_override: null,
      model_specialty: null,
      auto_compact_token_limit: null,
      comp_hash: "synthetic-context-fixture",
      default_reasoning_summary: "none",
      minimal_client_version: CODEX_APP_SERVER_VERSION,
      availability_nux: null,
      upgrade: null,
      experimental_supported_tools: [],
      available_in_plans: [],
      supports_search_tool: true,
      default_service_tier: null,
      service_tiers: [],
      additional_speed_tiers: [],
      supports_reasoning_summary_parameter: true,
      supports_reasoning_summaries: true,
    },
  ],
};

type ModelRequest = {
  instructions?: string;
  input: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
};

function developerText(request: ModelRequest): string {
  return request.input
    .filter((item) => item.role === "developer")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
}

function catalog(revision: string): string {
  return [
    "<available_skills>",
    ...Array.from({ length: 83 }, (_, index) =>
      [
        "<skill>",
        `<name>fixture-${revision}-${index}</name>`,
        `<description>Read-only fixture ${index}: 验证完整中文描述和路径，可读取技能说明。${" context".repeat(12)}</description>`,
        `<location>/isolated/fixture-${revision}-${index}/SKILL.md</location>`,
        "</skill>",
      ].join("\n"),
    ),
    "</available_skills>",
  ].join("\n");
}

// A Linux/macOS native-binary boundary regression, not a payload spy. No account
// credentials, production HOME, gateway, remote model, or external network is used.
describe.skipIf(process.platform === "win32")(
  "Codex supplemental context at model boundary",
  () => {
    it(
      "delivers complete snapshots on fresh and resumed threads without replacing native modes",
      { timeout: 120_000 },
      async (context) => {
        const dirs = useAutoCleanupTempDirTracker(context.onTestFinished);
        const root = dirs.make("codex-context-boundary-");
        const native = await createCodexNativeTestState(root);
        const requests: ModelRequest[] = [];
        const server = http.createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (data: Buffer) => chunks.push(data));
          request.on("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            try {
              requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest);
            } catch {
              response.writeHead(400).end();
              return;
            }
            const id = `response-${requests.length}`;
            const events = [
              { type: "response.created", response: { id } },
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  id: `msg-${id}`,
                  role: "assistant",
                  content: [{ type: "output_text", text: "fixture complete" }],
                },
              },
              {
                type: "response.completed",
                response: { id, usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } },
              },
            ];
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
              events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            );
          });
        });
        context.onTestFinished(async () => {
          server.closeAllConnections();
          if (server.listening) {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            });
          }
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("No loopback fixture address");
        }
        const catalogPath = path.join(root, "models.json");
        await fs.writeFile(catalogPath, JSON.stringify(MODEL_CATALOG));
        await fs.writeFile(
          path.join(native.codexHome, "config.toml"),
          [
            'model="context-probe-model"',
            `model_catalog_json=${JSON.stringify(catalogPath)}`,
            'model_provider="loopback-fixture"',
            'approval_policy="never"',
            'sandbox_mode="read-only"',
            'cli_auth_credentials_store="ephemeral"',
            'web_search="disabled"',
            "allow_login_shell=false",
            "[features]",
            "respect_system_proxy=false",
            "shell_snapshot=false",
            "code_mode=false",
            "code_mode_only=false",
            "[analytics]",
            "enabled=false",
            "[feedback]",
            "enabled=false",
            "[model_providers.loopback-fixture]",
            'name="Loopback fixture"',
            `base_url="http://127.0.0.1:${address.port}/v1"`,
            'wire_api="responses"',
            "requires_openai_auth=false",
            "supports_websockets=false",
          ].join("\n"),
        );
        const clients: CodexAppServerClient[] = [];
        context.onTestFinished(async () => {
          for (const client of clients) {
            await client.closeAndWait();
          }
        });
        const start = async () => {
          const transport = await createStdioTransport(
            {
              transport: "stdio",
              command: native.command,
              commandSource: "config",
              args: ["app-server"],
              cwd: native.cwd,
              headers: {},
            },
            native.env,
          );
          const client = CodexAppServerClient.fromTransportForTests(transport);
          clients.push(client);
          await client.initialize();
          expect(client.getServerVersion()).toBe(CODEX_APP_SERVER_VERSION);
          return client;
        };
        const appServer = resolveCodexAppServerRuntimeOptions({
          env: {},
          codexConfigToml: null,
          requirementsToml: null,
          pluginConfig: {
            appServer: { sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user" },
          },
        });
        const bindingStore = createCodexTestBindingStore();
        const bindingIdentity = {
          kind: "session" as const,
          agentId: "fixture",
          sessionId: "context-proof",
        };
        const params = createCodexUserInputTestParams();
        params.modelId = "context-probe-model";
        params.provider = "codex";
        params.thinkLevel = "low";
        params.trigger = "user";
        params.prompt = "Only acknowledge the fixture.";
        const turn = async (
          client: CodexAppServerClient,
          threadId: string,
          revision: string,
          preserveNativeTurnSettings = false,
        ) => {
          const before = requests.length;
          let detach = () => {};
          let timer: ReturnType<typeof setTimeout> | undefined;
          const completion = new Promise<unknown>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Native fixture turn timed out")), 30_000);
            detach = client.addNotificationHandler((event) => {
              if (event.method === "turn/completed") {
                resolve(event.params);
              }
            });
          });
          const request = buildTurnStartParams(params, {
            threadId,
            cwd: native.cwd,
            appServer,
            modelProvider: "loopback-fixture",
            preserveNativeTurnSettings,
          });
          try {
            await injectCodexTurnSupplementalInstructions({
              client,
              threadId,
              bindingStore,
              bindingIdentity,
              timeoutMs: 30_000,
              instructions: buildCodexTurnSupplementalInstructions(params, {
                turnScopedDeveloperInstructions: `SOUL_${revision}\nIDENTITY_${revision}`,
                memoryDeveloperInstructions: `MEMORY_RECALL_${revision}`,
                skillsDeveloperInstructions: catalog(revision),
              }),
            });
            await client.request("turn/start", request, { timeoutMs: 30_000 });
            expect(await completion).toMatchObject({ turn: { status: "completed" } });
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
            detach();
          }
          expect(requests.length).toBe(before + 1);
          return { request, actual: requests.at(-1)! };
        };
        const firstClient = await start();
        const { thread } = await firstClient.request("thread/start", {
          cwd: native.cwd,
          developerInstructions: "HOST_BASE_MARKER",
        });
        await bindingStore.mutate(bindingIdentity, {
          kind: "set",
          binding: { threadId: thread.id, cwd: native.cwd },
        });
        const first = await turn(firstClient, thread.id, "A");
        const text = developerText(first.actual);
        expect(text).toContain("CATALOG_DEFAULT_MARKER");
        expect(text.match(/<skill>/g) ?? []).toHaveLength(83);
        for (const marker of [
          "SOUL_A",
          "IDENTITY_A",
          "MEMORY_RECALL_A",
          "fixture-A-0",
          "fixture-A-41",
          "fixture-A-82",
          "/isolated/fixture-A-41/SKILL.md",
          "验证完整中文描述和路径",
        ]) {
          expect(text).toContain(marker);
        }
        expect(text).not.toContain("tokens truncated");
        expect(first.actual.instructions).toContain("MODEL_BASE_MARKER");
        expect(first.request.collaborationMode?.settings.developer_instructions).toBeNull();
        // The native same-loaded-thread store must not append an unchanged catalog.
        const second = await turn(firstClient, thread.id, "A");
        expect(developerText(second.actual).match(/<skill>/g)).toHaveLength(83);
        await firstClient.closeAndWait();
        const resumedClient = await start();
        const resumed = await resumedClient.request("thread/resume", {
          threadId: thread.id,
          cwd: native.cwd,
          excludeTurns: true,
        });
        expect(resumed.thread.id).toBe(thread.id);
        const coldUnchanged = await turn(resumedClient, thread.id, "A", true);
        expect(developerText(coldUnchanged.actual).match(/<skill>/g) ?? []).toHaveLength(83);
        const updated = await turn(resumedClient, thread.id, "B", true);
        expect(updated.request).not.toHaveProperty("collaborationMode");
        const updateText = developerText(updated.actual);
        expect(updateText).toContain("CATALOG_DEFAULT_MARKER");
        for (const marker of [
          "SOUL_B",
          "IDENTITY_B",
          "MEMORY_RECALL_B",
          "fixture-B-0",
          "fixture-B-41",
          "fixture-B-82",
        ]) {
          expect(updateText).toContain(marker);
        }
        expect(updateText).not.toContain("tokens truncated");
        // Historical snapshots are not a delete API: inspect the latest complete
        // snapshot separately, rather than pretending older transcript text vanished.
        const activeSnapshot = updateText.slice(
          updateText.lastIndexOf("<openclaw_turn_context revision="),
        );
        expect(activeSnapshot.match(/<skill>/g) ?? []).toHaveLength(83);
        expect(activeSnapshot).not.toContain("fixture-A-");
        expect(activeSnapshot).toContain("Only the latest complete snapshot is active");
        await expect(fs.access(path.join(native.codexHome, "auth.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );
  },
);
