// Local compatibility bridge that keeps memory_search routed through an existing QMD MCP service.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentWorkspaceDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  readMemoryFile,
  type MemoryEmbeddingProbeResult,
  type MemoryExtraPath,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySearchResult,
  type MemorySearchRuntimeDebug,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";

const log = createSubsystemLogger("memory");
const MCPORTER_OUTPUT_LIMIT = 250_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MAX_SNIPPET_CHARS = 2_200;
const DEFAULT_COLLECTION_PREFIX = "memory-dir-";
const qmdBridgeManagers = new Map<
  string,
  { agentId: string; manager: Promise<MemorySearchManager> }
>();

type QmdSearchMode = "query" | "search" | "vsearch";

export type QmdBridgeConfig = {
  enabled: true;
  serverName: string;
  startDaemon: boolean;
  searchMode: QmdSearchMode;
  rerank: boolean;
  maxResults: number;
  timeoutMs: number;
  maxSnippetChars: number;
  collectionPrefix: string;
  collectionOverrides: Record<string, string>;
};

type QmdBridgeCollection = {
  name: string;
  path?: string;
  documents?: number;
  lastUpdated?: string;
};

type QmdBridgeStatus = {
  totalDocuments?: number;
  needsEmbedding?: number;
  hasVectorIndex?: boolean;
  collections?: QmdBridgeCollection[];
};

type QmdBridgeQueryResult = {
  docid?: string;
  file?: string;
  score?: number | string;
  line?: number;
  startLine?: number;
  endLine?: number;
  start_line?: number;
  end_line?: number;
  snippet?: string;
};

type QmdBridgeQueryResponse = {
  results?: QmdBridgeQueryResult[];
};

type QmdBridgeQueryParams = {
  workspaceDir: string;
  serverName: string;
  collection: string;
  query: string;
  searchMode: QmdSearchMode;
  rerank: boolean;
  limit: number;
  minScore?: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type QmdBridgeClient = {
  startDaemon(params: { workspaceDir: string }): Promise<void>;
  status(params: {
    workspaceDir: string;
    serverName: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<QmdBridgeStatus>;
  query(params: QmdBridgeQueryParams): Promise<QmdBridgeQueryResponse>;
};

type RawQmdBridgePluginConfig = {
  enabled?: unknown;
  serverName?: unknown;
  startDaemon?: unknown;
  searchMode?: unknown;
  rerank?: unknown;
  maxResults?: unknown;
  timeoutMs?: unknown;
  maxSnippetChars?: unknown;
  collectionPrefix?: unknown;
  collectionOverrides?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function readSafeName(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : fallback;
}

function readSearchMode(value: unknown): QmdSearchMode {
  return value === "search" || value === "vsearch" || value === "query" ? value : "query";
}

function readCollectionOverrides(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [rawAgentId, rawCollection] of Object.entries(record)) {
    const agentId = normalizeAgentId(rawAgentId);
    const collection = readSafeName(rawCollection, "");
    if (agentId && collection) {
      out[agentId] = collection;
    }
  }
  return out;
}

function readRawQmdBridgePluginConfig(cfg: OpenClawConfig): RawQmdBridgePluginConfig | null {
  const root = cfg as OpenClawConfig & {
    plugins?: {
      entries?: Record<string, { config?: { qmdBridge?: RawQmdBridgePluginConfig } }>;
    };
  };
  return root.plugins?.entries?.["memory-core"]?.config?.qmdBridge ?? null;
}

export function resolveQmdBridgeConfig(
  cfg: OpenClawConfig,
  _agentId: string,
): QmdBridgeConfig | null {
  const raw = readRawQmdBridgePluginConfig(cfg);
  if (raw?.enabled !== true) {
    return null;
  }
  return {
    enabled: true,
    serverName: readSafeName(raw.serverName, "qmd"),
    startDaemon: raw.startDaemon !== false,
    searchMode: readSearchMode(raw.searchMode),
    rerank: raw.rerank !== false,
    maxResults: readPositiveInteger(raw.maxResults, DEFAULT_MAX_RESULTS),
    timeoutMs: readPositiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxSnippetChars: readPositiveInteger(raw.maxSnippetChars, DEFAULT_MAX_SNIPPET_CHARS),
    collectionPrefix:
      typeof raw.collectionPrefix === "string" && raw.collectionPrefix.trim()
        ? raw.collectionPrefix.trim()
        : DEFAULT_COLLECTION_PREFIX,
    collectionOverrides: readCollectionOverrides(raw.collectionOverrides),
  };
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the retained child handle.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

async function runMcporter(params: {
  workspaceDir: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(
        params.signal.reason instanceof Error
          ? params.signal.reason
          : new Error("QMD query aborted"),
      );
      return;
    }
    const child = spawn("mcporter", params.args, {
      cwd: params.workspaceDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (next.length > MCPORTER_OUTPUT_LIMIT) {
        killProcessTree(child);
        settle(() => reject(new Error("QMD mcporter output exceeded the safe limit")));
        return current;
      }
      return next;
    };
    const onAbort = () => {
      killProcessTree(child);
      settle(() =>
        reject(
          params.signal?.reason instanceof Error
            ? params.signal.reason
            : new Error("QMD query aborted"),
        ),
      );
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      settle(() => reject(new Error(`QMD mcporter timed out after ${params.timeoutMs}ms`)));
    }, params.timeoutMs);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(detail ? `QMD mcporter failed: ${detail}` : "QMD mcporter failed"));
      });
    });
  });
}

function parseMcporterJson(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  const record = asRecord(parsed);
  const structured = asRecord(record?.structuredContent);
  const value = structured ?? record;
  if (!value) {
    throw new Error("QMD mcporter returned an invalid JSON object");
  }
  return value;
}

function buildQmdSearches(
  query: string,
  searchMode: QmdSearchMode,
): Array<{ type: "lex" | "vec" | "hyde"; query: string }> {
  if (searchMode === "search") {
    return [{ type: "lex", query }];
  }
  if (searchMode === "vsearch") {
    return [{ type: "vec", query }];
  }
  const semanticQuery = query.replace(/(\w)-(?=\w)/g, "$1 ");
  return [
    { type: "lex", query },
    { type: "vec", query: semanticQuery },
    { type: "hyde", query: semanticQuery },
  ];
}

const defaultQmdBridgeClient: QmdBridgeClient = {
  async startDaemon({ workspaceDir }) {
    await runMcporter({
      workspaceDir,
      args: ["daemon", "start"],
      timeoutMs: 10_000,
    });
  },
  async status({ workspaceDir, serverName, timeoutMs, signal }) {
    const stdout = await runMcporter({
      workspaceDir,
      args: ["call", `${serverName}.status`, "--output", "json", "--timeout", String(timeoutMs)],
      timeoutMs: timeoutMs + 2_000,
      signal,
    });
    return parseMcporterJson(stdout) as QmdBridgeStatus;
  },
  async query(params) {
    const callArgs = {
      searches: buildQmdSearches(params.query, params.searchMode),
      limit: params.limit,
      minScore: params.minScore ?? 0,
      collections: [params.collection],
      rerank: params.searchMode === "query" ? params.rerank : false,
    };
    const stdout = await runMcporter({
      workspaceDir: params.workspaceDir,
      args: [
        "call",
        `${params.serverName}.query`,
        "--args",
        JSON.stringify(callArgs),
        "--output",
        "json",
        "--timeout",
        String(params.timeoutMs),
      ],
      timeoutMs: params.timeoutMs + 2_000,
      signal: params.signal,
    });
    return parseMcporterJson(stdout) as QmdBridgeQueryResponse;
  },
};

function resolveQmdCollection(params: {
  config: QmdBridgeConfig;
  agentId: string;
  workspaceDir: string;
  status: QmdBridgeStatus;
}): QmdBridgeCollection | null {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const collections = params.status.collections ?? [];
  const byLowerName = new Map(collections.map((entry) => [entry.name.toLowerCase(), entry]));
  const override = params.config.collectionOverrides[normalizedAgentId];
  const workspaceBase = path.basename(params.workspaceDir);
  const simplifiedWorkspaceBase = workspaceBase.replace(/^workspace[-_]/i, "");
  const candidates = [
    override,
    `${params.config.collectionPrefix}${normalizedAgentId}`,
    `${params.config.collectionPrefix}${workspaceBase}`,
    `${params.config.collectionPrefix}${simplifiedWorkspaceBase}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const match = byLowerName.get(candidate.toLowerCase());
    if (match) {
      return match;
    }
  }
  const workspaceMatch = collections.find(
    (entry) =>
      entry.path && path.basename(entry.path).toLowerCase() === workspaceBase.toLowerCase(),
  );
  return workspaceMatch ?? null;
}

function resolveSnippetLines(result: QmdBridgeQueryResult): { startLine: number; endLine: number } {
  const lineNumbers = [...(result.snippet ?? "").matchAll(/^(\d+):/gm)]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const explicitStart = result.startLine ?? result.start_line ?? result.line;
  const explicitEnd = result.endLine ?? result.end_line;
  const startLine =
    lineNumbers.length > 0
      ? Math.min(...lineNumbers)
      : typeof explicitStart === "number" && explicitStart > 0
        ? Math.floor(explicitStart)
        : 1;
  const endLine =
    lineNumbers.length > 0
      ? Math.max(...lineNumbers)
      : typeof explicitEnd === "number" && explicitEnd >= startLine
        ? Math.floor(explicitEnd)
        : startLine;
  return { startLine, endLine };
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveLocalResultPath(params: {
  workspaceDir: string;
  collection: string;
  rawFile: string;
}): Promise<{ relPath: string; observedAt: number } | null> {
  const normalizedFile = params.rawFile.replaceAll("\\", "/").replace(/^\.\//, "");
  const prefix = `${params.collection}/`;
  const relFromCollection = normalizedFile.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalizedFile.slice(prefix.length)
    : normalizedFile;
  if (!relFromCollection || path.posix.isAbsolute(relFromCollection)) {
    return null;
  }
  const candidates = [
    relFromCollection,
    relFromCollection.startsWith("memory/") ? null : `memory/${relFromCollection}`,
  ].filter((value): value is string => Boolean(value));
  for (const relPath of candidates) {
    const absPath = path.resolve(params.workspaceDir, relPath);
    if (!isPathInside(params.workspaceDir, absPath)) {
      continue;
    }
    try {
      const stat = await fs.stat(absPath);
      if (stat.isFile()) {
        return { relPath: relPath.replaceAll("\\", "/"), observedAt: stat.mtimeMs };
      }
    } catch {
      // Stale QMD document; try the compatibility path or skip it.
    }
  }
  return null;
}

function resolveResultOrigin(relPath: string): "owner" | "agent" | "untrusted" | "system" {
  const normalized = relPath.toLowerCase();
  if (normalized === "user.md") {
    return "owner";
  }
  if (normalized === "memory.md") {
    return "agent";
  }
  if (normalized === "dreams.md" || normalized.includes("/.dreams/")) {
    return "system";
  }
  return "untrusted";
}

class QmdBridgeMemoryManager implements MemorySearchManager {
  private currentStatus: QmdBridgeStatus;

  constructor(
    private readonly params: {
      agentId: string;
      workspaceDir: string;
      extraPaths: MemoryExtraPath[];
      config: QmdBridgeConfig;
      collection: QmdBridgeCollection;
      client: QmdBridgeClient;
      status: QmdBridgeStatus;
    },
  ) {
    this.currentStatus = params.status;
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      lexicalOnly?: boolean;
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      signal?: AbortSignal;
    },
  ): Promise<MemorySearchResult[]> {
    if (opts?.sources?.length && !opts.sources.includes("memory")) {
      return [];
    }
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const searchMode = opts?.lexicalOnly ? "search" : this.params.config.searchMode;
    const limit = Math.min(
      this.params.config.maxResults,
      readPositiveInteger(opts?.maxResults, this.params.config.maxResults),
    );
    const response = await this.params.client.query({
      workspaceDir: this.params.workspaceDir,
      serverName: this.params.config.serverName,
      collection: this.params.collection.name,
      query: trimmed,
      searchMode,
      rerank: this.params.config.rerank,
      limit,
      minScore: opts?.minScore,
      timeoutMs: this.params.config.timeoutMs,
      signal: opts?.signal,
    });
    const results: MemorySearchResult[] = [];
    const seen = new Set<string>();
    for (const entry of response.results ?? []) {
      if (typeof entry.file !== "string" || !entry.file.trim()) {
        continue;
      }
      const score = typeof entry.score === "number" ? entry.score : Number(entry.score);
      if (!Number.isFinite(score) || score < (opts?.minScore ?? 0)) {
        continue;
      }
      const localPath = await resolveLocalResultPath({
        workspaceDir: this.params.workspaceDir,
        collection: this.params.collection.name,
        rawFile: entry.file,
      });
      if (!localPath) {
        continue;
      }
      const lines = resolveSnippetLines(entry);
      const key = `${localPath.relPath}:${lines.startLine}:${lines.endLine}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({
        path: localPath.relPath,
        startLine: lines.startLine,
        endLine: lines.endLine,
        score,
        snippet: (entry.snippet ?? "").slice(0, this.params.config.maxSnippetChars),
        source: "memory",
        provenance: {
          originClass: resolveResultOrigin(localPath.relPath),
          sessionKind: "unknown",
          observedAt: localPath.observedAt,
        },
      });
    }
    opts?.onDebug?.({
      backend: "qmd",
      configuredMode: this.params.config.searchMode,
      effectiveMode: searchMode,
    });
    return results.toSorted((a, b) => b.score - a.score).slice(0, limit);
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    return await readMemoryFile({
      workspaceDir: this.params.workspaceDir,
      extraPaths: this.params.extraPaths,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
  }

  status(): MemoryProviderStatus {
    const documents = this.params.collection.documents ?? this.currentStatus.totalDocuments;
    const vectorAvailable = this.currentStatus.hasVectorIndex === true;
    const needsEmbedding = this.currentStatus.needsEmbedding ?? 0;
    return {
      backend: "qmd",
      provider: "qmd",
      model: "qmd-mcp",
      files: documents,
      chunks: documents,
      dirty: needsEmbedding > 0,
      workspaceDir: this.params.workspaceDir,
      sources: ["memory"],
      sourceCounts: [{ source: "memory", files: documents ?? 0, chunks: documents ?? 0 }],
      fts: { enabled: true, available: true },
      vector: {
        enabled: true,
        available: vectorAvailable,
        semanticAvailable: vectorAvailable,
        storeAvailable: vectorAvailable,
        index: vectorAvailable ? { state: "complete" } : { state: "unverified" },
      },
      custom: {
        qmdBridge: {
          serverName: this.params.config.serverName,
          collection: this.params.collection.name,
          needsEmbedding,
        },
      },
    };
  }

  async sync(): Promise<void> {
    this.currentStatus = await this.params.client.status({
      workspaceDir: this.params.workspaceDir,
      serverName: this.params.config.serverName,
      timeoutMs: this.params.config.timeoutMs,
    });
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult {
    return {
      ok: this.currentStatus.hasVectorIndex === true,
      checked: true,
      cached: true,
      checkedAtMs: Date.now(),
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    await this.sync();
    return {
      ok: this.currentStatus.hasVectorIndex === true,
      checked: true,
      cached: false,
      checkedAtMs: Date.now(),
    };
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    return await this.probeVectorAvailability();
  }

  async probeVectorAvailability(): Promise<boolean> {
    await this.sync();
    return this.currentStatus.hasVectorIndex === true;
  }
}

export async function createQmdBridgeMemoryManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  client?: QmdBridgeClient;
}): Promise<MemorySearchManager | null> {
  const config = resolveQmdBridgeConfig(params.cfg, params.agentId);
  if (!config) {
    return null;
  }
  const agentId = normalizeAgentId(params.agentId);
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const cacheKey = JSON.stringify({ agentId, workspaceDir, config });
  if (!params.client) {
    const cached = qmdBridgeManagers.get(cacheKey);
    if (cached) {
      return await cached.manager;
    }
  }
  const client = params.client ?? defaultQmdBridgeClient;
  const create = async (): Promise<MemorySearchManager> => {
    if (config.startDaemon) {
      try {
        await client.startDaemon({ workspaceDir });
      } catch (error) {
        log.warn(
          `QMD mcporter daemon start failed; continuing with direct call: ${formatErrorMessage(error)}`,
        );
      }
    }
    const status = await client.status({
      workspaceDir,
      serverName: config.serverName,
      timeoutMs: config.timeoutMs,
    });
    const collection = resolveQmdCollection({ config, agentId, workspaceDir, status });
    if (!collection) {
      throw new Error(`QMD collection for agent "${agentId}" was not found`);
    }
    const searchConfig = resolveMemorySearchConfig(params.cfg, agentId);
    return new QmdBridgeMemoryManager({
      agentId,
      workspaceDir,
      extraPaths: searchConfig?.extraPaths ?? [],
      config,
      collection,
      client,
      status,
    });
  };
  if (params.client) {
    return await create();
  }
  const manager = create();
  qmdBridgeManagers.set(cacheKey, { agentId, manager });
  try {
    return await manager;
  } catch (error) {
    qmdBridgeManagers.delete(cacheKey);
    throw error;
  }
}

export async function closeAllQmdBridgeMemoryManagers(): Promise<void> {
  const managers = [...qmdBridgeManagers.values()].map((entry) => entry.manager);
  qmdBridgeManagers.clear();
  await Promise.allSettled(
    managers.map(async (manager) => {
      const resolved = await manager;
      await resolved.close?.();
    }),
  );
}

export async function closeQmdBridgeMemoryManagersForAgent(agentId: string): Promise<void> {
  const normalizedAgentId = normalizeAgentId(agentId);
  const managers: Array<Promise<MemorySearchManager>> = [];
  for (const [key, entry] of qmdBridgeManagers) {
    if (entry.agentId !== normalizedAgentId) {
      continue;
    }
    qmdBridgeManagers.delete(key);
    managers.push(entry.manager);
  }
  await Promise.allSettled(
    managers.map(async (manager) => {
      const resolved = await manager;
      await resolved.close?.();
    }),
  );
}
