// Memory Core plugin module owns builtin search manager acquisition and cleanup.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";

const managerRuntimeLoader = createLazyRuntimeModule(() => import("../../manager-runtime.js"));
const loadManagerRuntime = managerRuntimeLoader;

type MemorySearchManagerPurpose = "default" | "status" | "cli";
type MemorySearchManagerParams = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
  debug?: {
    backend: "builtin" | "qmd";
    purpose: MemorySearchManagerPurpose;
    managerMs: number;
  };
};

export async function getMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const startedAt = Date.now();
  try {
    const { createQmdBridgeMemoryManager, resolveQmdBridgeConfig } =
      await import("./qmd-bridge-manager.js");
    if (resolveQmdBridgeConfig(params.cfg, params.agentId)) {
      const manager = await createQmdBridgeMemoryManager(params);
      return {
        manager,
        debug: {
          backend: "qmd",
          purpose: params.purpose ?? "default",
          managerMs: Math.max(0, Date.now() - startedAt),
        },
      };
    }
  } catch (err) {
    return {
      manager: null,
      error: formatErrorMessage(err),
      debug: {
        backend: "qmd",
        purpose: params.purpose ?? "default",
        managerMs: Math.max(0, Date.now() - startedAt),
      },
    };
  }
  const result = await getBuiltinMemorySearchManager(params);
  return {
    ...result,
    debug: {
      backend: "builtin",
      purpose: params.purpose ?? "default",
      managerMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

async function getBuiltinMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<Omit<MemorySearchManagerResult, "debug">> {
  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    return { manager: await MemoryIndexManager.get(params) };
  } catch (err) {
    return { manager: null, error: formatErrorMessage(err) };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  const { closeAllQmdBridgeMemoryManagers } = await import("./qmd-bridge-manager.js");
  await closeAllQmdBridgeMemoryManagers();
  if (managerRuntimeLoader.peek()) {
    const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
    await closeAllMemoryIndexManagers();
  }
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const { closeQmdBridgeMemoryManagersForAgent } = await import("./qmd-bridge-manager.js");
  await closeQmdBridgeMemoryManagersForAgent(params.agentId);
  if (managerRuntimeLoader.peek()) {
    const { closeMemoryIndexManagersForAgent } = await loadManagerRuntime();
    await closeMemoryIndexManagersForAgent({
      agentId: normalizeAgentId(params.agentId),
    });
  }
}
