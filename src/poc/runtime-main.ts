// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import { PocRuntime } from "./runtime";
import { buildRuntimeAgentConfigFromDefinitions } from "./modules/agent-definition-policy";

function readArg(name: string, defaultValue: string): string {
  for (let index = process.argv.length - 1; index >= 0; index -= 1) {
    if (process.argv[index] !== name) {
      continue;
    }
    if (index + 1 >= process.argv.length) {
      break;
    }
    return process.argv[index + 1];
  }
  return defaultValue;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readJsonFile(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main(): void {
  const mailboxRoot = path.resolve(readArg("--mailbox-root", "tmp/poc-mailbox/mailbox"));
  const stateRoot = path.resolve(readArg("--state-root", "tmp/poc-mailbox/state"));
  const taskId = readArg("--task-id", "task-demo-001");
  const instruction = readArg("--instruction", "Please review this change set.");
  const maxPasses = Number(readArg("--max-passes", "10"));
  const reviewerMode = readArg("--reviewer-mode", "deterministic");
  const cliTimeoutMs = Number(readArg("--cli-timeout-ms", "120000"));
  const codexModel = readArg("--codex-model", "").trim() || undefined;
  const claudeModel = readArg("--claude-model", "").trim() || undefined;
  const reviewInputMaxChars = Number(readArg("--review-input-max-chars", "120000"));
  const reviewInputExcerptChars = Number(readArg("--review-input-excerpt-chars", "24000"));
  const reviewInputIncludeDiff = hasFlag("--include-full-git-diff");
  const cliHomeMode = readArg("--cli-home-mode", "isolated");
  const agentsConfigJson =
    readArg("--agents-config-json", "").trim() || readArg("--agent-profiles-json", "").trim();
  const agentConfig = agentsConfigJson ? readJsonFile(path.resolve(agentsConfigJson)) : null;
  const derivedRuntimeConfig =
    Array.isArray(agentConfig?.agents) && Number(agentConfig?.version) === 1
      ? buildRuntimeAgentConfigFromDefinitions(agentConfig)
      : null;

  const runtime = new PocRuntime({
    mailboxRoot,
    stateRoot,
    reviewerMode: reviewerMode === "cli" ? "cli" : "deterministic",
    cliTimeoutMs,
    codexModel,
    claudeModel,
    reviewers: derivedRuntimeConfig
      ? derivedRuntimeConfig.runtime.reviewers
      : Array.isArray(agentConfig?.reviewers)
      ? agentConfig.reviewers
      : undefined,
    orchestratorId: derivedRuntimeConfig
      ? derivedRuntimeConfig.runtime.orchestrator_id
      : typeof agentConfig?.orchestrator_id === "string"
      ? agentConfig.orchestrator_id
      : undefined,
    aggregatorId: derivedRuntimeConfig
      ? derivedRuntimeConfig.runtime.aggregator_id
      : typeof agentConfig?.aggregator_id === "string"
      ? agentConfig.aggregator_id
      : undefined,
    reviewInputMaxChars,
    reviewInputExcerptChars,
    reviewInputIncludeDiff,
    cliHomeMode: cliHomeMode === "host" ? "host" : "isolated",
    requireTaskIdMatch: true,
    taskIdMatchTypes: ["review_result", "aggregation_result"]
  });
  runtime.init();
  runtime.seedTask(taskId, instruction);
  const run = runtime.runUntilStable(maxPasses);
  const finalDecision = runtime.getFinalDecision(taskId);
  const reviewerFailureCounts = runtime.getReviewerFailureCounts(taskId);
  const operationalGate =
    reviewerFailureCounts.auth_error > 0
      ? "block_and_fix_auth"
      : reviewerFailureCounts.network_error > 0
      ? "manual_review_network_retry"
      : reviewerFailureCounts.execution_error > 0
      ? "manual_review_execution_retry"
      : "healthy";

  const result = {
    mode: "mailbox_only_review",
    mailbox_root: mailboxRoot,
    state_root: stateRoot,
    task_id: taskId,
    reviewer_mode: reviewerMode,
    codex_model: codexModel ?? null,
    claude_model: claudeModel ?? null,
    cli_timeout_ms: cliTimeoutMs,
    review_input_max_chars: reviewInputMaxChars,
    review_input_excerpt_chars: reviewInputExcerptChars,
    review_input_include_diff: reviewInputIncludeDiff,
    cli_home_mode: cliHomeMode === "host" ? "host" : "isolated",
    cli_home_dir: path.resolve(stateRoot, "cli-home"),
    passes: run.passes,
    total_actions: run.totalActions,
    receipt_count: runtime.getReceiptCount(),
    orchestrator_id: runtime.getOrchestratorId(),
    aggregator_id: runtime.getAggregatorId(),
    reviewer_agents: runtime.getReviewerProfiles(),
    resolved_agent_definitions: derivedRuntimeConfig?.resolved?.agents ?? null,
    deadletter_aggregator: runtime.deadletterCount(runtime.getAggregatorId()),
    deadletter_orchestrator: runtime.deadletterCount(runtime.getOrchestratorId()),
    deadletter_by_agent: runtime.getDeadletterCounts(),
    quarantine_count: runtime.getQuarantineRows().length,
    reviewer_failure_counts: reviewerFailureCounts,
    operational_gate: operationalGate,
    dedup_policy: {
      key: "task_id + agent_id + msg_id",
      store: `${path.resolve(stateRoot, "message-receipts.jsonl")}`,
      survives_restart: true,
      retention: "until state_root cleanup"
    },
    final_decision: finalDecision
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!finalDecision) {
    process.stderr.write("No final decision reached.\n");
    process.exitCode = 1;
  }
}

main();
