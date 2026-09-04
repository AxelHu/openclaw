import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCanonicalDailyMemoryRelativePath,
  listDailyMemoryFilesUnderPath,
  listWorkspaceDailyMemoryFiles,
  parseDailyMemoryFileName,
} from "./daily-memory-paths.js";

const tempDirs: string[] = [];

async function createWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("daily memory paths", () => {
  it("builds the canonical year-month diary path", () => {
    expect(buildCanonicalDailyMemoryRelativePath("2026-09-04")).toBe(
      "memory/daily/2026-09/2026-09-04.md",
    );
    expect(() => buildCanonicalDailyMemoryRelativePath("2026-9-4")).toThrow(
      "invalid daily memory day",
    );
  });

  it("parses exact and legacy variant daily filenames", () => {
    expect(parseDailyMemoryFileName("2026-09-04.md")).toEqual({
      fileName: "2026-09-04.md",
      day: "2026-09-04",
      canonical: true,
    });
    expect(parseDailyMemoryFileName("2026-09-04-notes.md")).toMatchObject({
      day: "2026-09-04",
      canonical: false,
    });
    expect(parseDailyMemoryFileName("notes.md")).toBeNull();
  });

  it("prefers nested canonical files while retaining legacy variants", async () => {
    const workspaceDir = await createWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    const canonicalDir = path.join(memoryDir, "daily", "2026-09");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-09-04.md"), "legacy exact");
    await fs.writeFile(path.join(memoryDir, "2026-09-04-notes.md"), "legacy variant");
    await fs.writeFile(path.join(canonicalDir, "2026-09-04.md"), "canonical exact");

    const files = await listWorkspaceDailyMemoryFiles(workspaceDir);
    expect(files.map((entry) => entry.relativePath).toSorted()).toEqual([
      "memory/2026-09-04-notes.md",
      "memory/daily/2026-09/2026-09-04.md",
    ]);
  });

  it("falls back to an upstream-style root daily file when no canonical file exists", async () => {
    const workspaceDir = await createWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-09-03.md"), "legacy daily");

    expect(
      (await listWorkspaceDailyMemoryFiles(workspaceDir)).map((entry) => entry.relativePath),
    ).toEqual(["memory/2026-09-03.md"]);
  });

  it("finds canonical nested daily files when a history directory is supplied", async () => {
    const workspaceDir = await createWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    const canonicalDir = path.join(memoryDir, "daily", "2026-09");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-09-04.md"), "legacy duplicate");
    const canonicalPath = path.join(canonicalDir, "2026-09-04.md");
    await fs.writeFile(canonicalPath, "canonical");

    expect(await listDailyMemoryFilesUnderPath(memoryDir)).toEqual([canonicalPath]);
  });
});
