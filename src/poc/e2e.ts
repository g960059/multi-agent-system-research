// @ts-nocheck
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as cp from "node:child_process";
import { PocRuntime } from "./runtime";
import {
  applyAgentDefinitionPolicy,
  buildRuntimeAgentConfigFromDefinitions
} from "./modules/agent-definition-policy";

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

runCase("agent adapter profiles with mailbox fan-out", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-4");
  cleanDir(base);
  const runtime = new PocRuntime({
    mailboxRoot: path.join(base, "mailbox"),
    stateRoot: path.join(base, "state"),
    reviewerMode: "deterministic",
    reviewers: [
      {
        id: "codex-security-reviewer",
        provider: "codex",
        model: "gpt-5.3-codex",
        instruction: "security focus",
        display_name: "Codex Security Reviewer"
      },
      {
        id: "claude-performance-reviewer",
        provider: "claude",
        model: "claude-sonnet-4-5-20250929",
        instruction: "performance focus",
        display_name: "Claude Performance Reviewer"
      },
      {
        id: "codex-architecture-reviewer",
        provider: "codex",
        model: "gpt-5.3-codex",
        instruction: "architecture focus",
        display_name: "Codex Architecture Reviewer"
      }
    ]
  });
  runtime.init();

  const taskId = "task-e2e-4";
  runtime.seedTask(taskId, "normal review");

  for (const reviewer of runtime.getReviewerProfiles()) {
    const inbox = runtime.mailbox.peek(reviewer.id);
    assert.equal(inbox.length, 1, `expected one assignment for ${reviewer.id}`);
    const payload = inbox[0].envelope.payload;
    assert.equal(payload.reviewer_model_hint, reviewer.model);
    assert.equal(payload.reviewer_profile.id, reviewer.id);
    assert.equal(payload.reviewer_profile.provider, reviewer.provider);
    assert.ok(payload.instruction.includes(String(reviewer.instruction)), "reviewer specific instruction must be embedded");
  }

  runtime.runUntilStable(12);
  const reviews = runtime.state.getReviews(taskId);
  assert.equal(Object.keys(reviews).length, 3, "all configured reviewers must produce review_result");
  assert.ok(reviews["codex-security-reviewer"], "missing security reviewer result");
  assert.ok(reviews["claude-performance-reviewer"], "missing performance reviewer result");
  assert.ok(reviews["codex-architecture-reviewer"], "missing architecture reviewer result");

  const finalDecision = runtime.getFinalDecision(taskId);
  assert.ok(finalDecision, "final decision must exist");
  assert.equal(finalDecision.verdict, "PASS");
  assert.equal(finalDecision.next_action, "proceed");
  assert.equal(runtime.getQuarantineRows().length, 0, "no quarantine expected");
  assert.equal(runtime.deadletterCount(runtime.getAggregatorId()), 0, "no aggregator deadletter expected");
});

runCase("agent-definition policy auto fills command and message types", () => {
  const doc = {
    version: 1,
    agents: [
      {
        id: "orchestrator",
        name: "Control Orchestrator",
        role: "orchestrator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/orchestrator.md"
      },
      {
        id: "aggregator",
        name: "Review Aggregator",
        role: "aggregator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/aggregator.md"
      },
      {
        id: "codex-security-reviewer",
        name: "Codex Security Reviewer",
        role: "reviewer",
        provider: "codex",
        model: "gpt-5.3-codex",
        prompt_file: "prompts/reviewer/codex.md",
        instruction: "security focus"
      },
      {
        id: "claude-performance-reviewer",
        name: "Claude Performance Reviewer",
        role: "reviewer",
        provider: "claude",
        model: "claude-sonnet-4-5-20250929",
        prompt_file: "prompts/reviewer/claude.md",
        instruction: "performance focus"
      },
      {
        id: "codex-architecture-reviewer",
        name: "Codex Architecture Reviewer",
        role: "architect",
        provider: "codex",
        model: "gpt-5.3-codex",
        prompt_file: "prompts/reviewer/codex.md",
        instruction: "architecture focus"
      }
    ]
  };

  const resolved = applyAgentDefinitionPolicy(doc as any);
  for (const agent of resolved.agents) {
    assert.ok(Array.isArray(agent.command_template) && agent.command_template.length > 0, `missing command_template for ${agent.id}`);
    assert.ok(
      Array.isArray(agent.allowed_message_types) && agent.allowed_message_types.length > 0,
      `missing allowed_message_types for ${agent.id}`
    );
  }

  const compiled = buildRuntimeAgentConfigFromDefinitions(doc as any);
  assert.equal(compiled.runtime.orchestrator_id, "orchestrator");
  assert.equal(compiled.runtime.aggregator_id, "aggregator");
  assert.equal(compiled.runtime.reviewers.length, 3, "expected 3 reviewer-like agents");
});

runCase("agent-definition rejects local provider for reviewer-capable role", () => {
  const doc = {
    version: 1,
    agents: [
      {
        id: "orchestrator",
        name: "Control Orchestrator",
        role: "orchestrator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/orchestrator.md"
      },
      {
        id: "aggregator",
        name: "Review Aggregator",
        role: "aggregator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/aggregator.md"
      },
      {
        id: "local-reviewer",
        name: "Invalid Local Reviewer",
        role: "reviewer",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/codex.md"
      }
    ]
  };
  assert.throws(() => buildRuntimeAgentConfigFromDefinitions(doc as any), /unsupported reviewer provider/);
});

runCase("agent-definition rejects unknown env_profile reference", () => {
  const doc = {
    version: 1,
    agents: [
      {
        id: "orchestrator",
        name: "Control Orchestrator",
        role: "orchestrator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/orchestrator.md",
        env_profile: "local-default"
      },
      {
        id: "aggregator",
        name: "Review Aggregator",
        role: "aggregator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/aggregator.md",
        env_profile: "local-default"
      },
      {
        id: "codex-security-reviewer",
        name: "Codex Security Reviewer",
        role: "reviewer",
        provider: "codex",
        model: "gpt-5.3-codex",
        prompt_file: "prompts/reviewer/codex.md",
        env_profile: "codex-reviewer-typo"
      }
    ]
  };
  assert.throws(() => buildRuntimeAgentConfigFromDefinitions(doc as any), /unknown env_profile/);
});

runCase("runtime accepts agent-definition based config", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-5");
  cleanDir(base);
  const doc = {
    version: 1,
    agents: [
      {
        id: "orchestrator",
        name: "Control Orchestrator",
        role: "orchestrator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/orchestrator.md"
      },
      {
        id: "aggregator",
        name: "Review Aggregator",
        role: "aggregator",
        provider: "local",
        model: "deterministic-v1",
        prompt_file: "prompts/reviewer/aggregator.md"
      },
      {
        id: "codex-security-reviewer",
        name: "Codex Security Reviewer",
        role: "reviewer",
        provider: "codex",
        model: "gpt-5.3-codex",
        prompt_file: "prompts/reviewer/codex.md",
        instruction: "security focus"
      },
      {
        id: "claude-performance-reviewer",
        name: "Claude Performance Reviewer",
        role: "reviewer",
        provider: "claude",
        model: "claude-sonnet-4-5-20250929",
        prompt_file: "prompts/reviewer/claude.md",
        instruction: "performance focus"
      }
    ]
  };
  const compiled = buildRuntimeAgentConfigFromDefinitions(doc as any);
  const runtime = new PocRuntime({
    mailboxRoot: path.join(base, "mailbox"),
    stateRoot: path.join(base, "state"),
    reviewerMode: "deterministic",
    reviewers: compiled.runtime.reviewers,
    orchestratorId: compiled.runtime.orchestrator_id,
    aggregatorId: compiled.runtime.aggregator_id
  });
  runtime.init();
  runtime.seedTask("task-e2e-5", "normal review");
  runtime.runUntilStable(12);
  const finalDecision = runtime.getFinalDecision("task-e2e-5");
  assert.ok(finalDecision, "final decision must exist");
  assert.equal(finalDecision.verdict, "PASS");
  assert.equal(finalDecision.next_action, "proceed");
});

runCase("runtime-main duplicate args use last value", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-6");
  cleanDir(base);
  const run = cp.spawnSync(
    "node",
    [
      "dist/poc/runtime-main.js",
      "--mailbox-root",
      path.join(base, "mailbox"),
      "--state-root",
      path.join(base, "state"),
      "--task-id",
      "task-e2e-6",
      "--instruction",
      "normal review",
      "--review-input-max-chars",
      "80000",
      "--review-input-max-chars",
      "180000",
      "--max-passes",
      "8"
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    }
  );
  assert.equal(run.status, 0, String(run.stderr ?? ""));
  const result = JSON.parse(String(run.stdout ?? "").trim());
  assert.equal(result.review_input_max_chars, 180000);
});

runCase("cli reviewer honors command_template and env profile overrides", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-7");
  cleanDir(base);
  const script = [
    "const prompt = String(process.argv[1] ?? '');",
    "const match = prompt.match(/Set task_id exactly to \\\"([^\\\"]+)\\\"/);",
    "if (!match) { process.stderr.write('task_id not found'); process.exit(10); }",
    "if (process.env.TEST_REVIEWER_ENV !== 'ok') { process.stderr.write('env missing'); process.exit(11); }",
    "const payload = {",
    "schema_version: 1,",
    "task_id: match[1],",
    "model: 'mock-model',",
    "verdict: 'PASS',",
    "blocking: [],",
    "non_blocking: [],",
    "summary: 'mock reviewer pass',",
    "confidence: 'high',",
    "next_action: 'proceed',",
    "generated_at: new Date().toISOString(),",
    "raw_output_ref: 'artifact://mock/pass'",
    "};",
    "process.stdout.write(JSON.stringify(payload));"
  ].join("");
  const runtime = new PocRuntime({
    mailboxRoot: path.join(base, "mailbox"),
    stateRoot: path.join(base, "state"),
    reviewerMode: "cli",
    cliHomeMode: "host",
    reviewers: [
      {
        id: "codex-mock-reviewer",
        provider: "codex",
        model: "mock-model",
        command_template: ["node", "-e", script, "{prompt}"],
        env: {
          TEST_REVIEWER_ENV: "ok"
        }
      }
    ]
  });
  runtime.init();
  runtime.seedTask("task-e2e-7", "normal review");
  runtime.runUntilStable(12);

  const finalDecision = runtime.getFinalDecision("task-e2e-7");
  assert.ok(finalDecision, "final decision must exist");
  assert.equal(finalDecision.verdict, "PASS");
  assert.equal(finalDecision.next_action, "proceed");
});

runCase("cli reviewer invalid payload fails closed", () => {
  const base = path.resolve("tmp/poc-mailbox/e2e-case-8");
  cleanDir(base);
  const script = [
    "const prompt = String(process.argv[1] ?? '');",
    "const match = prompt.match(/Set task_id exactly to \\\"([^\\\"]+)\\\"/);",
    "if (!match) { process.stderr.write('task_id not found'); process.exit(10); }",
    "const payload = {",
    "schema_version: 1,",
    "task_id: match[1],",
    "model: 'mock-model',",
    "verdict: 'PASS',",
    "blocking: [],",
    "non_blocking: []",
    "};",
    "process.stdout.write(JSON.stringify(payload));"
  ].join("");
  const runtime = new PocRuntime({
    mailboxRoot: path.join(base, "mailbox"),
    stateRoot: path.join(base, "state"),
    reviewerMode: "cli",
    cliHomeMode: "host",
    reviewers: [
      {
        id: "codex-invalid-reviewer",
        provider: "codex",
        model: "mock-model",
        command_template: ["node", "-e", script, "{prompt}"]
      }
    ]
  });
  runtime.init();
  const taskId = "task-e2e-8";
  runtime.seedTask(taskId, "normal review");
  runtime.runUntilStable(12);

  const finalDecision = runtime.getFinalDecision(taskId);
  assert.ok(finalDecision, "final decision must exist");
  assert.equal(finalDecision.verdict, "FAIL");
  assert.equal(finalDecision.next_action, "manual_review_required");
  const failureCounts = runtime.getReviewerFailureCounts(taskId);
  assert.equal(failureCounts.execution_error, 1);
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
