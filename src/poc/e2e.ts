// @ts-nocheck
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PocRuntime } from "./runtime";

function cleanDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function runCase(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n`);
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined) {
      return "";
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function signatureForEnvelope(envelope: any): string {
  const target = { ...envelope, signature: "" };
  return crypto.createHash("sha256").update(stableStringify(target)).digest("hex");
}

runCase("happy path with duplicate review_result no-op+ack", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-1");
  cleanDir(base);
  const runtime = new PocRuntime({
    mailboxRoot: path.join(base, "mailbox"),
    stateRoot: path.join(base, "state")
  });
  runtime.init();
  runtime.seedTask("task-e2e-1", "normal review");

  // reviewer execution (pull model): consume assignment -> receipt+ack -> publish review_result
  runtime.processReviewer("codex");
  runtime.processReviewer("claude");

  // Inject at-least-once redelivery (same msg_id duplicate).
  const duplicatedMsgId = runtime.duplicateFirstInboxMessage("aggregator");
  assert.ok(duplicatedMsgId, "expected duplicated review_result message");

  runtime.processAggregator();
  runtime.processOrchestrator();

  const finalDecision = runtime.getFinalDecision("task-e2e-1");
  assert.ok(finalDecision, "final decision must exist");
  assert.equal(finalDecision.verdict, "PASS");
  assert.equal(finalDecision.next_action, "proceed");
  assert.equal(runtime.getQuarantineRows().length, 0, "no quarantine expected in happy path");
});

runCase("task_id mismatch quarantine for review_result", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-2");
  cleanDir(base);
  const runtime = new PocRuntime({
    mailboxRoot: path.join(base, "mailbox"),
    stateRoot: path.join(base, "state")
  });
  runtime.init();

  runtime.injectTaskIdMismatchReview("task-e2e-2", "task-e2e-2-evil");
  runtime.processAggregator();

  const quarantineRows = runtime.getQuarantineRows();
  assert.ok(quarantineRows.length > 0, "mismatch message must be quarantined");
  assert.ok(
    quarantineRows.some((row) => row.code === "TASK_ID_MISMATCH"),
    "expected TASK_ID_MISMATCH code"
  );
  assert.ok(runtime.deadletterCount("aggregator") > 0, "deadletter must contain the mismatched message");
});

runCase("from/sender_id mismatch quarantine", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-3");
  cleanDir(base);
  const runtime = new PocRuntime({
    mailboxRoot: path.join(base, "mailbox"),
    stateRoot: path.join(base, "state")
  });
  runtime.init();

  const badEnvelope = runtime.createEnvelope({
    taskId: "task-e2e-3",
    senderId: "codex",
    to: "aggregator",
    type: "review_result",
    payload: {
      schema_version: 1,
      task_id: "task-e2e-3",
      model: "gpt-5-codex",
      verdict: "PASS",
      blocking: [],
      non_blocking: [],
      summary: "spoof test",
      confidence: "high",
      next_action: "proceed",
      generated_at: new Date().toISOString(),
      raw_output_ref: "artifact://task-e2e-3/spoof"
    },
    stateVersion: 1
  });
  badEnvelope.from = "claude";
  // Re-sign after tampering to prove validator checks semantic mismatch, not only signature.
  badEnvelope.signature = signatureForEnvelope(badEnvelope);
  runtime.mailbox.publish(badEnvelope);

  runtime.processAggregator();
  const quarantineRows = runtime.getQuarantineRows();
  assert.ok(quarantineRows.some((row) => row.code === "SENDER_ID_MISMATCH"), "expected SENDER_ID_MISMATCH");
  assert.ok(runtime.deadletterCount("aggregator") > 0, "deadletter must contain spoofed message");
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
