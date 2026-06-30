/**
 * Creates and configures stdio-backed Codex app-server transports, including
 * Windows spawn normalization and environment filtering.
 */
import { spawn } from "node:child_process";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type CodexAppServerSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_SPAWN_RUNTIME: CodexAppServerSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

/** Resolves the concrete command/argv/shell settings used to spawn Codex app-server. */
export function resolveCodexAppServerSpawnInvocation(
  options: CodexAppServerStartOptions,
  runtime: CodexAppServerSpawnRuntime = DEFAULT_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  if (options.commandSource === "managed") {
    throw new Error("Managed Codex app-server start options must be resolved before spawn.");
  }
  const program = resolveWindowsSpawnProgram({
    command: options.command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "@openai/codex",
  });
  const resolved = materializeWindowsSpawnProgram(program, options.args);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

/**
 * Injects outbound HTTP(S) proxy environment variables onto the Codex app-server
 * spawn env. We default to a hardcoded Shadowsocks endpoint on
 * `http://127.0.0.1:1080` (mirrored WSL -> Windows host loopback) so the child
 * can reach chatgpt.com without requiring operators to set any global proxy
 * variables on the gateway. Operators can override via:
 *
 *   - `OPENCLAW_CODEX_PROXY` (preferred): full URL like `http://user:pass@host:port`
 *   - `HTTPS_PROXY` / `HTTP_PROXY`: standard names; if set, they win over the
 *     hardcoded Shadowsocks URL (so the operator can route via their own proxy
 *     without touching openclaw code)
 *
 * Setting `OPENCLAW_CODEX_PROXY=` (empty) explicitly disables the override even if
 * the hardcoded URL or `HTTPS_PROXY` would otherwise win. `OPENCLAW_CODEX_NO_PROXY`
 * overrides the default noProxy list (`127.0.0.1,localhost,::1`).
 *
 * Only affects the spawned Codex app-server child; openclaw's own HTTP client is
 * driven by `models.providers.*.request.proxy` and is intentionally untouched here.
 */
const DEFAULT_CODEX_PROXY_URL = "http://127.0.0.1:1080";
const DEFAULT_CODEX_NO_PROXY = "127.0.0.1,localhost,::1";

function resolveCodexAppServerProxyEnv(baseEnv: NodeJS.ProcessEnv): {
  url: string | null;
  noProxy: string;
} {
  const explicitOverride = baseEnv.OPENCLAW_CODEX_PROXY;
  if (explicitOverride !== undefined) {
    if (explicitOverride.trim().length === 0) return { url: null, noProxy: "" };
    const noProxyOverride =
      typeof baseEnv.OPENCLAW_CODEX_NO_PROXY === "string"
        ? baseEnv.OPENCLAW_CODEX_NO_PROXY.trim()
        : "";
    return { url: explicitOverride.trim(), noProxy: noProxyOverride || DEFAULT_CODEX_NO_PROXY };
  }
  const https = typeof baseEnv.HTTPS_PROXY === "string" ? baseEnv.HTTPS_PROXY.trim() : "";
  const http = typeof baseEnv.HTTP_PROXY === "string" ? baseEnv.HTTP_PROXY.trim() : "";
  const url = https || http || DEFAULT_CODEX_PROXY_URL;
  const noProxyOverride =
    typeof baseEnv.OPENCLAW_CODEX_NO_PROXY === "string"
      ? baseEnv.OPENCLAW_CODEX_NO_PROXY.trim()
      : "";
  return { url, noProxy: noProxyOverride || DEFAULT_CODEX_NO_PROXY };
}

/** Merges app-server environment overrides while honoring clearEnv and unsafe key filtering. */
export function resolveCodexAppServerSpawnEnv(
  options: Pick<CodexAppServerStartOptions, "env" | "clearEnv">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  copySafeEnvironmentEntries(env, baseEnv);
  copySafeEnvironmentEntries(env, options.env ?? {});
  // Apply Codex-scoped proxy only to the spawned app-server child so we do not
  // pollute openclaw's own HTTP clients (which use models.providers.*.request.proxy).
  const proxy = resolveCodexAppServerProxyEnv(baseEnv);
  if (proxy.url) {
    env.HTTPS_PROXY = proxy.url;
    env.HTTP_PROXY = proxy.url;
    if (proxy.noProxy) env.NO_PROXY = proxy.noProxy;
    // Mirror lowercase variants used by some HTTP clients.
    env.https_proxy = proxy.url;
    env.http_proxy = proxy.url;
    if (proxy.noProxy) env.no_proxy = proxy.noProxy;
  }
  const keysToClear = normalizedEnvironmentKeys(options.clearEnv ?? []);
  if (platform === "win32") {
    const lowerCaseKeysToClear = new Set(keysToClear.map((key) => key.toLowerCase()));
    for (const candidate of Object.keys(env)) {
      if (lowerCaseKeysToClear.has(candidate.toLowerCase())) {
        delete env[candidate];
      }
    }
  } else {
    for (const key of keysToClear) {
      delete env[key];
    }
  }
  return env;
}

function normalizedEnvironmentKeys(rawKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (const rawKey of rawKeys) {
    const key = rawKey.trim();
    if (key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
}

function copySafeEnvironmentEntries(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_ENVIRONMENT_KEYS.has(key)) {
      continue;
    }
    target[key] = value;
  }
}

/** Spawns the Codex app-server process and returns the shared transport interface. */
export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  const env = resolveCodexAppServerSpawnEnv(options);
  const invocation = resolveCodexAppServerSpawnInvocation(options, {
    platform: process.platform,
    env,
    execPath: process.execPath,
  });
  return spawn(invocation.command, invocation.args, {
    env,
    detached: process.platform !== "win32",
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: invocation.windowsHide,
  });
}
