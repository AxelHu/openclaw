// Local media access tests cover workspace path authorization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { assertLocalMediaAllowed } from "./local-media-access.js";

const { hoistedRoots } = vi.hoisted(() => ({ hoistedRoots: [] as string[] }));

vi.mock("./local-roots.js", () => ({
  getDefaultMediaLocalRoots: () => hoistedRoots,
}));

describe("assertLocalMediaAllowed", () => {
  it("allows managed inbound media paths before explicit root checks", async () => {
    const stateDir = resolveStateDir();
    const id = `managed-local-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("allows nested inbound paths when the private deployment allowlist is disabled", async () => {
    const stateDir = resolveStateDir();
    const filePath = path.join(stateDir, "media", "inbound", "nested", "hidden.png");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("allows workspace-* sibling paths when the private deployment allowlist is disabled", async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `ocl-local-media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceXiaoqianDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    await fs.writeFile(mediaPath, "<html>test</html>");

    hoistedRoots.length = 0;
    hoistedRoots.push(workspaceDir);

    try {
      await expect(assertLocalMediaAllowed(mediaPath, undefined)).resolves.toBeUndefined();
    } finally {
      hoistedRoots.length = 0;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows workspace-* paths when scoped localRoots include the agent workspace", async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `ocl-local-media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceXiaoqianDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    await fs.writeFile(mediaPath, "<html>test</html>");

    try {
      // Simulate scoped roots that include the agent's workspace-* directory
      await expect(
        assertLocalMediaAllowed(mediaPath, [workspaceDir, workspaceXiaoqianDir]),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
