import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRuntimeArgs,
  extractStructuredJson,
  isPreflightSummary,
  isRuntimeResult,
  parseArgs
} from "./run_parallel_review.mjs";

test("extractStructuredJson picks runtime object, not trailing unrelated JSON", () => {
  const runtime = {
    mode: "mailbox_only_review",
    task_id: "task-a",
    reviewer_failure_counts: { auth_error: 0, network_error: 0, execution_error: 0, total: 0 },
    operational_gate: "healthy",
    final_decision: { task_id: "task-a", verdict: "PASS", next_action: "proceed" }
  };
  const stdout = [
    "npm banner line",
    JSON.stringify(runtime),
    JSON.stringify({ level: "info", msg: "other-json-log" })
  ].join("\n");

  const parsed = extractStructuredJson({ stdout, stderr: "" }, isRuntimeResult);
  assert.deepEqual(parsed, runtime);
});

test("extractStructuredJson falls back to stderr when stdout has no match", () => {
  const preflight = {
    codex: { ok: true, status: 0, category: "ok" },
    claude: { ok: false, status: 1, category: "auth_error" },
    cli_home_mode: "isolated"
  };
  const parsed = extractStructuredJson(
    { stdout: "no json here", stderr: `warn\n${JSON.stringify(preflight)}` },
    isPreflightSummary
  );
  assert.deepEqual(parsed, preflight);
});

test("parseArgs and buildRuntimeArgs for cli mode", () => {
  const options = parseArgs([
    "--reviewer-mode",
    "cli",
    "--cli-home-mode",
    "host",
    "--task-id",
    "task-cli",
    "--instruction",
    "normal review",
    "--codex-model",
    "gpt-5.3-codex",
    "--claude-model",
    "claude-sonnet",
    "--max-passes",
    "7",
    "--cli-timeout-ms",
    "240000",
    "--review-input-max-chars",
    "90000",
    "--review-input-excerpt-chars",
    "20000",
    "--max-buffer-mb",
    "96",
    "--include-full-git-diff"
  ]);
  const args = buildRuntimeArgs(options);
  assert.deepEqual(args, [
    "run",
    "poc:runtime:cli",
    "--",
    "--task-id",
    "task-cli",
    "--instruction",
    "normal review",
    "--cli-home-mode",
    "host",
    "--codex-model",
    "gpt-5.3-codex",
    "--claude-model",
    "claude-sonnet",
    "--max-passes",
    "7",
    "--cli-timeout-ms",
    "240000",
    "--review-input-max-chars",
    "90000",
    "--review-input-excerpt-chars",
    "20000",
    "--include-full-git-diff"
  ]);
});

test("mailbox integration deterministic run exposes mailbox metrics", { timeout: 120000 }, () => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");
  const taskId = `task-mailbox-integration-${Date.now()}`;
  const run = cp.spawnSync(
    "node",
    [
      "agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs",
      "--reviewer-mode",
      "deterministic",
      "--task-id",
      taskId,
      "--instruction",
      "normal review"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    }
  );
  assert.equal(run.status, 0, String(run.stderr ?? ""));

  const stdout = String(run.stdout ?? "").trim();
  assert.ok(stdout, "expected JSON output");
  const summary = JSON.parse(stdout);
  assert.equal(summary.mode, "mailbox_only_review");
  assert.equal(summary.task_id, taskId);
  assert.equal(summary.reviewer_mode, "deterministic");
  assert.equal(summary.operational_gate, "healthy");
  assert.ok(Number(summary.receipt_count) > 0, "receipt_count should be positive");
  assert.equal(summary.quarantine_count, 0);
  assert.ok(summary.dedup_policy && typeof summary.dedup_policy.key === "string");
  assert.ok(summary.deadletter_by_agent && typeof summary.deadletter_by_agent === "object");
});

test("buildRuntimeArgs for deterministic mode", () => {
  const options = parseArgs([
    "--reviewer-mode",
    "deterministic",
    "--task-id",
    "task-det",
    "--instruction",
    "normal review",
    "--max-passes",
    "4"
  ]);
  const args = buildRuntimeArgs(options);
  assert.deepEqual(args, [
    "run",
    "poc:runtime",
    "--",
    "--task-id",
    "task-det",
    "--instruction",
    "normal review",
    "--max-passes",
    "4"
  ]);
});

test("buildRuntimeArgs prefers agents-config-json over reviewer profiles", () => {
  const options = parseArgs([
    "--reviewer-mode",
    "deterministic",
    "--task-id",
    "task-def",
    "--instruction",
    "normal review",
    "--agents-config-json",
    "plan/mailbox-poc-agent-definitions.example.json"
  ]);
  const args = buildRuntimeArgs(options);
  assert.deepEqual(args, [
    "run",
    "poc:runtime",
    "--",
    "--task-id",
    "task-def",
    "--instruction",
    "normal review",
    "--agents-config-json",
    path.resolve("plan/mailbox-poc-agent-definitions.example.json")
  ]);
});
