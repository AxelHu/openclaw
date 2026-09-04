// Canonical local daily-memory paths plus backward-compatible legacy discovery.
import fs from "node:fs/promises";
import path from "node:path";

export const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i;
const DAILY_MEMORY_MONTH_DIR_RE = /^\d{4}-\d{2}$/;

export type DailyMemoryFile = {
  fileName: string;
  day: string;
  canonical: boolean;
};

export type WorkspaceDailyMemoryFile = DailyMemoryFile & {
  absolutePath: string;
  relativePath: string;
  source: "canonical" | "legacy";
};

export function parseDailyMemoryFileName(fileName: string): DailyMemoryFile | null {
  const match = fileName.match(DAILY_MEMORY_FILE_NAME_RE);
  const day = match?.[1];
  return day
    ? {
        fileName,
        day,
        canonical: fileName.toLowerCase() === `${day}.md`,
      }
    : null;
}

export function compareDailyMemoryFilesByNewestDay(
  left: DailyMemoryFile,
  right: DailyMemoryFile,
): number {
  const dayOrder = right.day.localeCompare(left.day);
  if (dayOrder !== 0) {
    return dayOrder;
  }
  if (left.canonical !== right.canonical) {
    return left.canonical ? -1 : 1;
  }
  return left.fileName.localeCompare(right.fileName);
}

export function buildCanonicalDailyMemoryRelativePath(day: string): string {
  const parsed = parseDailyMemoryFileName(`${day}.md`);
  if (!parsed || parsed.day !== day) {
    throw new Error(`invalid daily memory day: ${day}`);
  }
  return `memory/daily/${day.slice(0, 7)}/${day}.md`;
}

async function readDirOrEmpty(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Lists daily memory files from the local canonical layout and the upstream
 * legacy root layout. If both exact YYYY-MM-DD.md files exist for one day,
 * the canonical nested file wins; legacy timestamp/name variants remain
 * readable for backward compatibility.
 */
export async function listWorkspaceDailyMemoryFiles(
  workspaceDir: string,
): Promise<WorkspaceDailyMemoryFile[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  const files: WorkspaceDailyMemoryFile[] = [];

  for (const entry of await readDirOrEmpty(memoryDir)) {
    if (!entry.isFile()) {
      continue;
    }
    const parsed = parseDailyMemoryFileName(entry.name);
    if (!parsed) {
      continue;
    }
    files.push({
      ...parsed,
      absolutePath: path.join(memoryDir, entry.name),
      relativePath: `memory/${entry.name}`,
      source: "legacy",
    });
  }

  const dailyDir = path.join(memoryDir, "daily");
  for (const monthEntry of await readDirOrEmpty(dailyDir)) {
    if (!monthEntry.isDirectory() || !DAILY_MEMORY_MONTH_DIR_RE.test(monthEntry.name)) {
      continue;
    }
    const monthDir = path.join(dailyDir, monthEntry.name);
    for (const entry of await readDirOrEmpty(monthDir)) {
      if (!entry.isFile()) {
        continue;
      }
      const parsed = parseDailyMemoryFileName(entry.name);
      if (!parsed || parsed.day.slice(0, 7) !== monthEntry.name) {
        continue;
      }
      files.push({
        ...parsed,
        absolutePath: path.join(monthDir, entry.name),
        relativePath: `memory/daily/${monthEntry.name}/${entry.name}`,
        source: "canonical",
      });
    }
  }

  const canonicalExactDays = new Set(
    files
      .filter((entry) => entry.source === "canonical" && entry.canonical)
      .map((entry) => entry.day),
  );
  return files.filter(
    (entry) => !(entry.source === "legacy" && entry.canonical && canonicalExactDays.has(entry.day)),
  );
}

/** Recursively finds daily files below an explicitly supplied history path. */
export async function listDailyMemoryFilesUnderPath(
  inputPath: string,
  maxDepth = 3,
): Promise<string[]> {
  const resolvedPath = path.resolve(inputPath);
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (stat.isFile()) {
    return parseDailyMemoryFileName(path.basename(resolvedPath)) ? [resolvedPath] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readDirOrEmpty(dir)) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (parseDailyMemoryFileName(entry.name)) {
          found.push(absolutePath);
        }
        continue;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        await walk(absolutePath, depth + 1);
      }
    }
  };
  await walk(resolvedPath, 0);

  const canonicalRank = (filePath: string) =>
    /[/\\]daily[/\\]\d{4}-\d{2}[/\\]\d{4}-\d{2}-\d{2}\.md$/i.test(filePath) ? 0 : 1;
  const preferredByName = new Map<string, string>();
  for (const filePath of found) {
    const name = path.basename(filePath).toLowerCase();
    const current = preferredByName.get(name);
    if (!current || canonicalRank(filePath) < canonicalRank(current)) {
      preferredByName.set(name, filePath);
    }
  }
  return [...preferredByName.values()].toSorted((left, right) => {
    const dayOrder = path.basename(left).localeCompare(path.basename(right));
    return dayOrder !== 0 ? dayOrder : canonicalRank(left) - canonicalRank(right);
  });
}
