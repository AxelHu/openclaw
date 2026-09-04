import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQmdBridgeMemoryManager,
  resolveQmdBridgeConfig,
  type QmdBridgeClient,
} from "./qmd-bridge-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-bridge-"));
  tempDirs.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "memory", "knowledge"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "memory", "knowledge", "qmd.md"),
    "# QMD\n\n本地语义检索。\n",
  );
  return workspaceDir;
}

function buildConfig(workspaceDir: string) {
  return {
    agents: { entries: { main: { workspace: workspaceDir } } },
    memory: { search: { enabled: true } },
    plugins: {
      entries: {
        "memory-core": {
          config: {
            qmdBridge: {
              enabled: true,
              serverName: "qmd",
              startDaemon: true,
              searchMode: "query",
              rerank: true,
              maxResults: 6,
              timeoutMs: 30_000,
              collectionPrefix: "memory-dir-",
            },
          },
        },
      },
    },
  };
}

describe("QMD memory bridge", () => {
  it("defaults to disabled until the local bridge is explicitly enabled", () => {
    expect(resolveQmdBridgeConfig({}, "main")).toBeNull();
  });

  it("routes memory search through the agent-scoped QMD collection", async () => {
    const workspaceDir = await createWorkspace();
    const query = vi.fn(async () => ({
      results: [
        {
          docid: "#abc123",
          file: "memory-dir-main/memory/knowledge/qmd.md",
          score: 0.91,
          line: 3,
          snippet: "3: 本地语义检索。",
        },
      ],
    }));
    const client: QmdBridgeClient = {
      startDaemon: vi.fn(async () => {}),
      status: vi.fn(async () => ({
        totalDocuments: 10,
        needsEmbedding: 0,
        hasVectorIndex: true,
        collections: [
          {
            name: "memory-dir-main",
            path: "/Users/axelhu/qmd-data/workspace-main",
            documents: 10,
          },
        ],
      })),
      query,
    };

    const manager = await createQmdBridgeMemoryManager({
      cfg: buildConfig(workspaceDir),
      agentId: "main",
      client,
    });
    expect(manager).not.toBeNull();

    const results = await manager!.search("QMD 本地检索", { maxResults: 4 });

    expect(client.startDaemon).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "qmd",
        collection: "memory-dir-main",
        searchMode: "query",
        rerank: true,
        limit: 4,
      }),
    );
    expect(results).toEqual([
      expect.objectContaining({
        path: "memory/knowledge/qmd.md",
        startLine: 3,
        endLine: 3,
        score: 0.91,
        source: "memory",
      }),
    ]);
    expect(manager!.status()).toMatchObject({
      backend: "qmd",
      provider: "qmd",
      files: 10,
      dirty: false,
    });
  });

  it("fails closed instead of searching another agent collection", async () => {
    const workspaceDir = await createWorkspace();
    const client: QmdBridgeClient = {
      startDaemon: vi.fn(async () => {}),
      status: vi.fn(async () => ({
        totalDocuments: 10,
        needsEmbedding: 0,
        hasVectorIndex: true,
        collections: [
          {
            name: "memory-dir-other",
            path: "/Users/axelhu/qmd-data/workspace-other",
            documents: 10,
          },
        ],
      })),
      query: vi.fn(async () => ({ results: [] })),
    };

    await expect(
      createQmdBridgeMemoryManager({
        cfg: buildConfig(workspaceDir),
        agentId: "main",
        client,
      }),
    ).rejects.toThrow('QMD collection for agent "main" was not found');
    expect(client.query).not.toHaveBeenCalled();
  });

  it("does not expose the workspace collection for a sessions-only request", async () => {
    const workspaceDir = await createWorkspace();
    const client: QmdBridgeClient = {
      startDaemon: vi.fn(async () => {}),
      status: vi.fn(async () => ({
        totalDocuments: 10,
        needsEmbedding: 0,
        hasVectorIndex: true,
        collections: [
          {
            name: "memory-dir-main",
            path: "/Users/axelhu/qmd-data/workspace-main",
            documents: 10,
          },
        ],
      })),
      query: vi.fn(async () => ({ results: [] })),
    };
    const manager = await createQmdBridgeMemoryManager({
      cfg: buildConfig(workspaceDir),
      agentId: "main",
      client,
    });

    await expect(manager!.search("历史会话", { sources: ["sessions"] })).resolves.toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });
});
