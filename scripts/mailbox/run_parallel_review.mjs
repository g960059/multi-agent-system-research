#!/usr/bin/env node

import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findRunner(repoRoot) {
  const localRunner = path.resolve(repoRoot, "agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs");
  const home = process.env.HOME ? path.resolve(process.env.HOME) : "";
  const globalRunner = home
    ? path.resolve(home, ".agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs")
    : "";
  const candidates = [localRunner, globalRunner].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..");
  const runner = findRunner(repoRoot);
  if (!runner) {
    process.stderr.write(
      [
        "run_parallel_review.mjs not found.",
        "Checked:",
        `- ${path.resolve(repoRoot, "agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs")}`,
        process.env.HOME
          ? `- ${path.resolve(process.env.HOME, ".agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs")}`
          : "- $HOME/.agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs"
      ].join("\n") + "\n"
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const hasRepoRoot = args.includes("--repo-root");
  const forwardedArgs = hasRepoRoot ? args : ["--repo-root", repoRoot, ...args];

  const run = cp.spawnSync(process.execPath, [runner, ...forwardedArgs], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });

  if (run.error) {
    process.stderr.write(`${String(run.error.message ?? run.error)}\n`);
    process.exit(1);
  }
  if (typeof run.status === "number") {
    process.exit(run.status);
  }
  if (run.signal) {
    process.kill(process.pid, run.signal);
    return;
  }
  process.exit(1);
}

main();
