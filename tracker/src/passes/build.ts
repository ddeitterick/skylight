// Build identity stamped into every pass.json: git short SHA of the running
// checkout (the Pi runs from a git clone and self-updates nightly), an
// optional human label, and the Node version.

import { execFile } from "node:child_process";
import type { PassBuild } from "./summary.js";

export function envBuild(): PassBuild {
  return {
    version: process.env.SKYLIGHT_VERSION ?? "unknown",
    label: process.env.BUILD_LABEL ?? null,
    node: process.version,
  };
}

/** `git rev-parse --short HEAD` in the repo, once; falls back to envBuild(). */
export function detectBuild(repoDir: string): Promise<PassBuild> {
  const fallback = envBuild();
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--short", "HEAD"],
      { cwd: repoDir, timeout: 5000 },
      (err, stdout) => {
        const sha = String(stdout ?? "").trim();
        resolve(!err && /^[0-9a-f]{6,}$/.test(sha) ? { ...fallback, version: sha } : fallback);
      },
    );
  });
}
