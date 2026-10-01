import fs from "node:fs";
import path from "node:path";

// Fixtures for the operator's reads: what a project's state directory holds, byte for
// byte, so a test can say a read left it exactly as it was.

/**
 * Every entry under `directory`, by path relative to it: a file as its bytes, a directory
 * as `<directory>`. Directories are entries too, because a read that creates an empty
 * `locks/` or `asks/` has written something even though no file appeared. A directory that
 * does not exist is the empty snapshot.
 */
export function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const name = path.relative(directory, full);
      if (entry.isDirectory()) {
        entries[name] = "<directory>";
        walk(full);
      } else {
        entries[name] = fs.readFileSync(full).toString("base64");
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return entries;
}
