import path from "node:path";
import { safeRealpathSync } from "../infra/boundary-path.js";

/** Accounting identity for an already-authorized successful file read.
 * Only the caller's registered skill paths are matched; resolving an alias
 * never discovers a new skill or changes file-access permissions.
 */
export function skillUsageReadPath(filePath: string): string {
  if (filePath.startsWith("node://")) {
    return filePath;
  }
  const absolute = path.resolve(filePath);
  // Sandbox/remote projections may not exist on the host. Keep their exact
  // registered lexical identity when no real local path can be resolved.
  return safeRealpathSync(absolute) ?? absolute;
}
