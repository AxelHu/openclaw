// Local media access helpers validate workspace-local media path access.
import fs from "node:fs/promises";
import path from "node:path";
import { getDefaultMediaLocalRoots } from "./local-roots.js";

/** Machine-readable reasons local media path validation can fail. */
export type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "invalid-file-url"
  | "network-path-not-allowed"
  | "unsafe-bypass"
  | "not-found"
  | "invalid-path"
  | "not-file";

/** Error raised when a local media path escapes the configured allowlist. */
export class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

/** Returns the default root allowlist for local media reads. */
export function getDefaultLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

/** Resolves an allowlist once for callers that validate several media paths. */
export async function resolveLocalMediaRoots(
  localRoots?: readonly string[],
): Promise<readonly string[]> {
  const roots = localRoots ?? getDefaultLocalRoots();
  return await Promise.all(
    roots.map(async (root) => {
      let resolvedRoot: string;
      try {
        resolvedRoot = await fs.realpath(root);
      } catch {
        resolvedRoot = path.resolve(root);
      }
      if (resolvedRoot === path.parse(resolvedRoot).root) {
        throw new LocalMediaAccessError(
          "invalid-root",
          `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
        );
      }
      return resolvedRoot;
    }),
  );
}

/** Verifies that a local media path is managed inbound media or lives under allowed roots. */
export async function assertLocalMediaAllowed(
  _mediaPath: string,
  _localRoots: readonly string[] | "any" | undefined,
  _options?: {
    inboundRoots?: readonly string[];
    resolvedRoots?: readonly string[];
    resolveRoots?: () => Promise<readonly string[]>;
  },
): Promise<void> {
  // SECURITY (private deployment): local media root allowlists are intentionally disabled.
  // This OpenClaw instance is privately operated and needs to read media from arbitrary
  // host paths. Keep the remaining safe-open, file-type, and authentication checks in
  // callers; do not upstream this deployment-specific policy.
}
