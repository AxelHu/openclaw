import type fs from "node:fs";
import type os from "node:os";
import type path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeElevenLabsApiKeyPool,
  resolveElevenLabsApiKeyPool,
  resolveElevenLabsLocalApiKeys,
  rotateElevenLabsApiKeys,
} from "./api-keys.js";

type FixtureEntry = string | { kind: "directory"; files: Record<string, string> };

function fixtureDeps(entries: Record<string, FixtureEntry>) {
  return {
    fs: {
      existsSync: (candidate: string) => Object.hasOwn(entries, candidate),
      readFileSync: (candidate: string) => {
        const value = entries[candidate];
        if (typeof value !== "string") {
          throw new Error("not a file");
        }
        return value;
      },
      readdirSync: (candidate: string) => {
        const value = entries[candidate];
        if (!value || typeof value === "string") {
          throw new Error("not a directory");
        }
        return Object.keys(value.files).map((name) => ({
          name,
          isFile: () => true,
        }));
      },
    } as unknown as typeof fs,
    os: { homedir: () => "/tmp/home" } as unknown as typeof os,
    path: { join: (...parts: string[]) => parts.join("/") } as unknown as typeof path,
  };
}

describe("ElevenLabs API key pool", () => {
  it("reads and deduplicates JSON, key-directory, legacy-file, and profile sources", () => {
    const deps = fixtureDeps({
      "/tmp/home/.config/elevenlabs/credentials.json": JSON.stringify({
        api_keys: ["json-a", "json-b", "json-a"],
        api_key: "legacy-json",
      }),
      "/tmp/home/.config/elevenlabs/keys": {
        kind: "directory",
        files: { secondary: "directory-key\n", ".incoming": "ignored" },
      },
      "/tmp/home/.config/elevenlabs/keys/secondary": "directory-key\n",
      "/tmp/home/.config/elevenlabs/key": "ELEVENLABS_API_KEY=legacy-json\n",
      "/tmp/home/.profile": "export XI_API_KEY=profile-key\n",
    });

    expect(resolveElevenLabsLocalApiKeys(deps)).toEqual([
      "json-a",
      "json-b",
      "legacy-json",
      "directory-key",
      "profile-key",
    ]);
  });

  it("uses the standard environment pool before local files", () => {
    const pool = resolveElevenLabsApiKeyPool(
      { rotate: false },
      {
        ...fixtureDeps({
          "/tmp/home/.config/elevenlabs/key": "local-key",
        }),
        collectEnvKeys: () => ["env-a", "env-b", "env-a"],
      },
    );

    expect(pool).toEqual({ apiKeys: ["env-a", "env-b"], source: "environment" });
  });

  it("keeps an explicit provider key pinned", () => {
    expect(
      resolveElevenLabsApiKeyPool(
        { explicitApiKey: " explicit-key " },
        { collectEnvKeys: () => ["env-key"] },
      ),
    ).toEqual({ apiKeys: ["explicit-key"], source: "explicit" });
  });

  it("round-robins the starting key without duplicating entries", () => {
    const first = rotateElevenLabsApiKeys(["key-a", "key-b", "key-a"]);
    const second = rotateElevenLabsApiKeys(["key-a", "key-b", "key-a"]);

    expect(first).toHaveLength(2);
    expect(second).toEqual([first[1], first[0]]);
  });

  it.each([401, 402, 403, 429])("tries the next key after HTTP %s", async (status) => {
    const attempts: string[] = [];
    await expect(
      executeElevenLabsApiKeyPool({
        apiKeys: ["key-a", "key-b"],
        execute: async (apiKey) => {
          attempts.push(apiKey);
          if (apiKey === "key-a") {
            throw Object.assign(new Error("rejected"), { status });
          }
          return "ok";
        },
      }),
    ).resolves.toBe("ok");
    expect(attempts).toEqual(["key-a", "key-b"]);
  });

  it.each([400, 404, 408, 500, 503])("does not replay an ambiguous HTTP %s", async (status) => {
    const attempts: string[] = [];
    await expect(
      executeElevenLabsApiKeyPool({
        apiKeys: ["key-a", "key-b"],
        execute: async (apiKey) => {
          attempts.push(apiKey);
          throw Object.assign(new Error("failed"), { status });
        },
      }),
    ).rejects.toThrow("failed");
    expect(attempts).toEqual(["key-a"]);
  });
});
