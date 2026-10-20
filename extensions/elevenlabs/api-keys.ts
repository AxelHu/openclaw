// ElevenLabs credential-pool discovery and request-level key rotation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  isRecord,
  normalizeOptionalString,
  normalizeUniqueStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const PROVIDER_ID = "elevenlabs";
const PROFILE_CANDIDATES = [".profile", ".zprofile", ".zshrc", ".bashrc"] as const;
const CREDENTIALS_JSON_PATH = [".config", "elevenlabs", "credentials.json"] as const;
const LEGACY_KEY_PATH = [".config", "elevenlabs", "key"] as const;
const KEY_DIRECTORY_PATH = [".config", "elevenlabs", "keys"] as const;
const MAX_KEY_FILES = 128;
const ROTATABLE_HTTP_STATUSES = new Set([401, 402, 403, 429]);

const ELEVENLABS_ENV_AUTH_SOURCE = "ElevenLabs environment key pool";
export const ELEVENLABS_LOCAL_AUTH_SOURCE = "ElevenLabs local credential pool";

type ElevenLabsApiKeyDeps = {
  fs?: typeof fs;
  os?: typeof os;
  path?: typeof path;
  collectEnvKeys?: () => string[];
};

export type ElevenLabsApiKeyPool = {
  apiKeys: string[];
  source: "explicit" | "environment" | "local" | "missing";
};

let apiKeyCursor = 0;

function parseKeyEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseKeyEntries(entry));
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeApiKeys(values: Iterable<unknown>): string[] {
  return normalizeUniqueStringEntries(
    Array.from(values).flatMap((value) => parseKeyEntries(value)),
  );
}

function readCredentialJson(deps: ElevenLabsApiKeyDeps, home: string): string[] {
  const fsImpl = deps.fs ?? fs;
  const pathImpl = deps.path ?? path;
  const credentialsPath = pathImpl.join(home, ...CREDENTIALS_JSON_PATH);
  if (!fsImpl.existsSync(credentialsPath)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(fsImpl.readFileSync(credentialsPath, "utf8"));
    return isRecord(parsed) ? normalizeApiKeys([parsed.api_keys, parsed.api_key]) : [];
  } catch {
    return [];
  }
}

function readLegacyKeyFile(deps: ElevenLabsApiKeyDeps, home: string): string[] {
  const fsImpl = deps.fs ?? fs;
  const pathImpl = deps.path ?? path;
  const keyPath = pathImpl.join(home, ...LEGACY_KEY_PATH);
  if (!fsImpl.existsSync(keyPath)) {
    return [];
  }
  try {
    const text = fsImpl.readFileSync(keyPath, "utf8").trim();
    return normalizeApiKeys([text.includes("=") ? text.split("=", 2)[1] : text]);
  } catch {
    return [];
  }
}

function readKeyDirectory(deps: ElevenLabsApiKeyDeps, home: string): string[] {
  const fsImpl = deps.fs ?? fs;
  const pathImpl = deps.path ?? path;
  const directory = pathImpl.join(home, ...KEY_DIRECTORY_PATH);
  if (!fsImpl.existsSync(directory)) {
    return [];
  }
  try {
    const entries = fsImpl
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_KEY_FILES);
    return normalizeApiKeys(
      entries.map((entry) => fsImpl.readFileSync(pathImpl.join(directory, entry.name), "utf8")),
    );
  } catch {
    return [];
  }
}

function readProfileKeys(deps: ElevenLabsApiKeyDeps, home: string): string[] {
  const fsImpl = deps.fs ?? fs;
  const pathImpl = deps.path ?? path;
  const values: unknown[] = [];
  const assignment =
    /(?:^|\n)\s*(?:export\s+)?(?:ELEVENLABS_API_KEYS|ELEVENLABS_API_KEY|XI_API_KEY)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\n#]*))/g;

  for (const candidate of PROFILE_CANDIDATES) {
    const fullPath = pathImpl.join(home, candidate);
    if (!fsImpl.existsSync(fullPath)) {
      continue;
    }
    try {
      const text = fsImpl.readFileSync(fullPath, "utf8");
      for (const match of text.matchAll(assignment)) {
        values.push(match[1] ?? match[2] ?? match[3]);
      }
    } catch {
      // Optional shell-profile fallback; continue to the remaining candidates.
    }
  }
  return normalizeApiKeys(values);
}

export function resolveElevenLabsLocalApiKeys(deps: ElevenLabsApiKeyDeps = {}): string[] {
  const home = (deps.os ?? os).homedir();
  return normalizeApiKeys([
    ...readCredentialJson(deps, home),
    ...readKeyDirectory(deps, home),
    ...readLegacyKeyFile(deps, home),
    ...readProfileKeys(deps, home),
  ]);
}

export function rotateElevenLabsApiKeys(apiKeys: readonly string[]): string[] {
  const normalized = normalizeApiKeys(apiKeys);
  if (normalized.length <= 1) {
    return normalized;
  }
  const start = apiKeyCursor % normalized.length;
  apiKeyCursor = (apiKeyCursor + 1) % Number.MAX_SAFE_INTEGER;
  return [...normalized.slice(start), ...normalized.slice(0, start)];
}

export function resolveElevenLabsApiKeyPool(
  params: { explicitApiKey?: string; rotate?: boolean } = {},
  deps: ElevenLabsApiKeyDeps = {},
): ElevenLabsApiKeyPool {
  const explicitApiKey = normalizeOptionalString(params.explicitApiKey);
  if (explicitApiKey) {
    return { apiKeys: [explicitApiKey], source: "explicit" };
  }

  const envApiKeys = normalizeApiKeys(
    deps.collectEnvKeys?.() ?? collectProviderApiKeysForExecution({ provider: PROVIDER_ID }),
  );
  const localApiKeys = envApiKeys.length === 0 ? resolveElevenLabsLocalApiKeys(deps) : [];
  const apiKeys = envApiKeys.length > 0 ? envApiKeys : localApiKeys;
  const ordered = params.rotate === false ? apiKeys : rotateElevenLabsApiKeys(apiKeys);
  return {
    apiKeys: ordered,
    source: envApiKeys.length > 0 ? "environment" : localApiKeys.length > 0 ? "local" : "missing",
  };
}

export function resolveElevenLabsProviderAuth():
  | { kind: "api-key"; apiKey: string; source: string; mode: "api-key" }
  | undefined {
  const pool = resolveElevenLabsApiKeyPool({ rotate: false });
  const apiKey = pool.apiKeys[0];
  if (!apiKey) {
    return undefined;
  }
  return {
    kind: "api-key",
    apiKey,
    mode: "api-key",
    source:
      pool.source === "environment" ? ELEVENLABS_ENV_AUTH_SOURCE : ELEVENLABS_LOCAL_AUTH_SOURCE,
  };
}

function shouldRotateForError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const status = error.status ?? error.statusCode;
  return typeof status === "number" && ROTATABLE_HTTP_STATUSES.has(status);
}

export async function executeElevenLabsApiKeyPool<T>(params: {
  apiKeys: readonly string[];
  execute: (apiKey: string) => Promise<T>;
}): Promise<T> {
  return await executeWithApiKeyRotation({
    provider: PROVIDER_ID,
    apiKeys: [...params.apiKeys],
    execute: params.execute,
    shouldRetry: ({ error }) => shouldRotateForError(error),
  });
}
