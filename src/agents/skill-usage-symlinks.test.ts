import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSkillUsageMatches } from "./agent-tools.before-tool-call.diagnostics.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";

let root: string;
let source: string;
let alias: string;
let context: HookContext;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-alias-"));
  source = path.join(root, "repo", "fixture");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "# Fixture");
  const managed = path.join(root, "skills");
  fs.mkdirSync(managed);
  fs.symlinkSync(source, path.join(managed, "fixture"), "dir");
  alias = path.join(managed, "fixture", "SKILL.md");
  context = {
    workspaceDir: root,
    skillsSnapshot: {
      prompt: "",
      skills: [{ name: "fixture" }],
      resolvedSkills: [
        {
          name: "fixture",
          description: "test",
          filePath: path.join(source, "SKILL.md"),
          baseDir: source,
          source: "openclaw-managed",
          disableModelInvocation: false,
        },
      ],
    },
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("skill accounting for source-linked entries", () => {
  it.each(["read", "exec"])(
    "matches successful %s aliases to a known canonical source",
    (toolName) => {
      const result = findSkillUsageMatches({
        toolName,
        toolParams:
          toolName === "read" ? { path: alias } : { command: `cat '${alias}' >/dev/null` },
        ctx: context,
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.skillName).toBe("fixture");
      expect(result[0]?.skillFile).toBe(path.join(source, "SKILL.md"));
    },
  );

  it("normalizes aliases, relative paths and repeated shell operands without double matches", () => {
    const command = `cat '${alias}' ./skills/fixture/SKILL.md '${source}/SKILL.md'`;
    expect(
      findSkillUsageMatches({ toolName: "exec", toolParams: { command }, ctx: context }),
    ).toHaveLength(1);
  });

  it("matches an existing sandbox-materialized path but keeps its registered file identity", () => {
    const ctx: HookContext = {
      workspaceDir: root,
      skillUsagePaths: [
        {
          readPath: path.join(source, "SKILL.md"),
          skillFile: "/original/fixture/SKILL.md",
          skillName: "fixture",
          skillSource: "workspace",
        },
      ],
    };
    for (const toolName of ["read", "exec"]) {
      const result = findSkillUsageMatches({
        toolName,
        toolParams: toolName === "read" ? { path: alias } : { command: `cat '${alias}'` },
        ctx,
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.skillFile).toBe("/original/fixture/SKILL.md");
    }
  });

  it("does not count a same-named unregistered skill, an example string or a dangling alias", () => {
    const other = path.join(root, "other", "fixture");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "SKILL.md"), "# Different");
    const dangling = path.join(root, "dangling");
    fs.symlinkSync(path.join(root, "missing"), dangling, "dir");
    for (const p of [path.join(other, "SKILL.md"), path.join(dangling, "SKILL.md")]) {
      expect(
        findSkillUsageMatches({ toolName: "read", toolParams: { path: p }, ctx: context }),
      ).toHaveLength(0);
    }
    expect(
      findSkillUsageMatches({
        toolName: "exec",
        toolParams: { command: `echo "cat ${alias}"` },
        ctx: context,
      }),
    ).toHaveLength(0);
  });

  it("retains exact matching for unavailable materialized paths without inventing file identity", () => {
    const ctx: HookContext = {
      workspaceDir: root,
      skillUsagePaths: [
        {
          readPath: "/sandbox/not-local/fixture/SKILL.md",
          skillFile: "/original/fixture/SKILL.md",
          skillName: "fixture",
          skillSource: "workspace",
        },
      ],
    };
    expect(
      findSkillUsageMatches({
        toolName: "read",
        toolParams: { path: "/sandbox/not-local/fixture/SKILL.md" },
        ctx,
      })[0]?.skillFile,
    ).toBe("/original/fixture/SKILL.md");
  });
});
