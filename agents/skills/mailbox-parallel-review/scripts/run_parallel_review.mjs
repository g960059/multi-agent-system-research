#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { pathToFileURL } from "node:url";

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs [options]",
      "",
      "Options:",
      "  --repo-root <path>                  Repository root (default: cwd)",
      "  --task-id <id>                      Task id (default: auto-generated)",
      '  --instruction <text>                Review instruction (default: "normal review")',
      "  --reviewer-mode <cli|deterministic> Runtime mode (default: cli)",
      "  --cli-home-mode <host|isolated>     CLI home mode (default: host)",
      "  --agents-config-json <path>         JSON file for full agent-definition config",
      "  --agent-profiles-json <path>        JSON file for reviewer adapter profiles",
      "  --codex-model <model>               Codex model override",
      "  --claude-model <model>              Claude model override",
      "  --max-passes <n>                    Max passes override",
      "  --cli-timeout-ms <n>                CLI timeout override",
      "  --review-input-max-chars <n>        Runtime review input cap override",
      "  --review-input-excerpt-chars <n>    Runtime review excerpt cap override",
      "  --max-buffer-mb <n>                 Max stdout/stderr buffer per command (default: 64)",
      "  --include-full-git-diff             Include full diff in review input",
      "  --skip-preflight                    Skip poc:cli:check in cli mode",
      "  --allow-preflight-failure           Continue even if preflight fails",
      "  --output-json <path>                Save full runtime JSON",
      "  --help                              Show this help"
    ].join("\n") + "\n"
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runCommand(cmd, args, options = {}) {
  const run = cp.spawnSync(cmd, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024
  });
  return {
    ok: !run.error && run.status === 0,
    status: run.status,
    stdout: String(run.stdout ?? ""),
    stderr: String(run.stderr ?? ""),
    error: run.error ? String(run.error.message ?? run.error) : null
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPreflightSummary(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (!isRecord(value.codex) || !isRecord(value.claude)) {
    return false;
  }
  return typeof value.codex.ok === "boolean" && typeof value.claude.ok === "boolean";
}

function isRuntimeResult(value) {
  if (!isRecord(value)) {
    return false;
  }
  const counts = value.reviewer_failure_counts;
  const hasValidCounts =
    isRecord(counts) &&
    Number.isInteger(counts.auth_error) &&
    Number.isInteger(counts.network_error) &&
    Number.isInteger(counts.execution_error) &&
    Number.isInteger(counts.total);
  const hasValidFinalDecision =
    value.final_decision === null ||
    (isRecord(value.final_decision) &&
      typeof value.final_decision.task_id === "string" &&
      typeof value.final_decision.verdict === "string" &&
      typeof value.final_decision.next_action === "string");
  return (
    value.mode === "mailbox_only_review" &&
    typeof value.task_id === "string" &&
    hasValidCounts &&
    typeof value.operational_gate === "string" &&
    hasValidFinalDecision
  );
}

function extractJsonObjects(text) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const candidate = text.slice(start, i + 1);
          try {
            candidates.push(JSON.parse(candidate));
          } catch {
            // continue
          }
          start = -1;
        }
      }
    }
  }
  return candidates;
}

function pickLastMatching(values, matcher) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (matcher(values[i])) {
      return values[i];
    }
  }
  return null;
}

function extractStructuredJson(outputs, matcher) {
  const stdoutValues = extractJsonObjects(String(outputs.stdout ?? ""));
  const stdoutHit = pickLastMatching(stdoutValues, matcher);
  if (stdoutHit) {
    return stdoutHit;
  }
  const mergedValues = extractJsonObjects(`${String(outputs.stdout ?? "")}\n${String(outputs.stderr ?? "")}`);
  return pickLastMatching(mergedValues, matcher);
}

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`Invalid ${name}: ${value}`);
  }
  return Math.floor(n);
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    taskId: `task-parallel-review-${Date.now()}`,
    instruction: "normal review",
    reviewerMode: "cli",
    cliHomeMode: "host",
    agentsConfigJson: "",
    agentProfilesJson: "",
    codexModel: "",
    claudeModel: "",
    maxPasses: null,
    cliTimeoutMs: null,
    reviewInputMaxChars: null,
    reviewInputExcerptChars: null,
    includeFullGitDiff: false,
    skipPreflight: false,
    allowPreflightFailure: false,
    outputJson: "",
    maxBufferMb: toInt(process.env.MAILBOX_REVIEW_MAX_BUFFER_MB ?? "64", "MAILBOX_REVIEW_MAX_BUFFER_MB")
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--include-full-git-diff") {
      options.includeFullGitDiff = true;
      continue;
    }
    if (arg === "--skip-preflight") {
      options.skipPreflight = true;
      continue;
    }
    if (arg === "--allow-preflight-failure") {
      options.allowPreflightFailure = true;
      continue;
    }
    const next = argv[i + 1];
    if (!arg.startsWith("--")) {
      fail(`Unknown argument: ${arg}`);
    }
    if (next === undefined || next.startsWith("--")) {
      fail(`Missing value for ${arg}`);
    }

    if (arg === "--repo-root") {
      options.repoRoot = path.resolve(next);
    } else if (arg === "--task-id") {
      options.taskId = next;
    } else if (arg === "--instruction") {
      options.instruction = next;
    } else if (arg === "--reviewer-mode") {
      options.reviewerMode = next;
    } else if (arg === "--cli-home-mode") {
      options.cliHomeMode = next;
    } else if (arg === "--agents-config-json") {
      options.agentsConfigJson = path.resolve(next);
    } else if (arg === "--agent-profiles-json") {
      options.agentProfilesJson = path.resolve(next);
    } else if (arg === "--codex-model") {
      options.codexModel = next;
    } else if (arg === "--claude-model") {
      options.claudeModel = next;
    } else if (arg === "--max-passes") {
      options.maxPasses = toInt(next, "max-passes");
    } else if (arg === "--cli-timeout-ms") {
      options.cliTimeoutMs = toInt(next, "cli-timeout-ms");
    } else if (arg === "--review-input-max-chars") {
      options.reviewInputMaxChars = toInt(next, "review-input-max-chars");
    } else if (arg === "--review-input-excerpt-chars") {
      options.reviewInputExcerptChars = toInt(next, "review-input-excerpt-chars");
    } else if (arg === "--max-buffer-mb") {
      options.maxBufferMb = toInt(next, "max-buffer-mb");
    } else if (arg === "--output-json") {
      options.outputJson = path.resolve(next);
    } else {
      fail(`Unknown option: ${arg}`);
    }
    i += 1;
  }

  if (!["cli", "deterministic"].includes(options.reviewerMode)) {
    fail(`Invalid --reviewer-mode: ${options.reviewerMode}`);
  }
  if (!["host", "isolated"].includes(options.cliHomeMode)) {
    fail(`Invalid --cli-home-mode: ${options.cliHomeMode}`);
  }
  if (options.agentsConfigJson && options.agentProfilesJson) {
    fail("Use either --agents-config-json or --agent-profiles-json, not both");
  }
  return options;
}

function toBufferBytes(maxBufferMb) {
  return Math.floor(maxBufferMb * 1024 * 1024);
}

function runPreflight(options) {
  const env = {
    ...process.env,
    POC_CLI_HOME_MODE: options.cliHomeMode
  };
  if (options.codexModel) {
    env.POC_CODEX_MODEL = options.codexModel;
  }
  if (options.claudeModel) {
    env.POC_CLAUDE_MODEL = options.claudeModel;
  }
  if (options.cliTimeoutMs) {
    env.POC_CLI_CHECK_TIMEOUT_MS = String(options.cliTimeoutMs);
  }

  const preflight = runCommand("npm", ["run", "poc:cli:check"], {
    cwd: options.repoRoot,
    env,
    maxBufferBytes: toBufferBytes(options.maxBufferMb)
  });
  const parsed = extractStructuredJson(preflight, isPreflightSummary);
  return {
    run: preflight,
    parsed
  };
}

function buildRuntimeArgs(options) {
  if (options.reviewerMode === "cli") {
    const args = [
      "run",
      "poc:runtime:cli",
      "--",
      "--task-id",
      options.taskId,
      "--instruction",
      options.instruction,
      "--cli-home-mode",
      options.cliHomeMode
    ];
    if (options.agentsConfigJson) {
      args.push("--agents-config-json", options.agentsConfigJson);
    } else if (options.agentProfilesJson) {
      args.push("--agent-profiles-json", options.agentProfilesJson);
    }
    if (options.codexModel) {
      args.push("--codex-model", options.codexModel);
    }
    if (options.claudeModel) {
      args.push("--claude-model", options.claudeModel);
    }
    if (options.maxPasses !== null) {
      args.push("--max-passes", String(options.maxPasses));
    }
    if (options.cliTimeoutMs !== null) {
      args.push("--cli-timeout-ms", String(options.cliTimeoutMs));
    }
    if (options.reviewInputMaxChars !== null) {
      args.push("--review-input-max-chars", String(options.reviewInputMaxChars));
    }
    if (options.reviewInputExcerptChars !== null) {
      args.push("--review-input-excerpt-chars", String(options.reviewInputExcerptChars));
    }
    if (options.includeFullGitDiff) {
      args.push("--include-full-git-diff");
    }
    return args;
  }

  const args = [
    "run",
    "poc:runtime",
    "--",
    "--task-id",
    options.taskId,
    "--instruction",
    options.instruction
  ];
  if (options.agentsConfigJson) {
    args.push("--agents-config-json", options.agentsConfigJson);
  } else if (options.agentProfilesJson) {
    args.push("--agent-profiles-json", options.agentProfilesJson);
  }
  if (options.maxPasses !== null) {
    args.push("--max-passes", String(options.maxPasses));
  }
  return args;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let preflightSummary = null;

  if (options.reviewerMode === "cli" && !options.skipPreflight) {
    process.stderr.write(`Running preflight (cli-home-mode=${options.cliHomeMode})...\n`);
    const preflight = runPreflight(options);
    if (!preflight.parsed) {
      process.stderr.write("Failed to parse preflight JSON output.\n");
      process.stderr.write(preflight.run.stdout);
      process.stderr.write(preflight.run.stderr);
      process.exit(2);
    }
    preflightSummary = {
      codex: preflight.parsed?.codex ?? null,
      claude: preflight.parsed?.claude ?? null,
      cli_home_mode: preflight.parsed?.cli_home_mode ?? options.cliHomeMode
    };
    const codexOk = Boolean(preflight.parsed?.codex?.ok);
    const claudeOk = Boolean(preflight.parsed?.claude?.ok);
    if (!codexOk || !claudeOk) {
      process.stderr.write("Preflight reports reviewer failure.\n");
      if (!options.allowPreflightFailure) {
        process.stderr.write("Use --allow-preflight-failure to continue anyway.\n");
        process.stdout.write(
          `${JSON.stringify(
            {
              task_id: options.taskId,
              reviewer_mode: options.reviewerMode,
              preflight: preflightSummary,
              aborted: "preflight_failed"
            },
            null,
            2
          )}\n`
        );
        process.exit(2);
      }
    }
  }

  const runtimeArgs = buildRuntimeArgs(options);
  process.stderr.write(`Running runtime: npm ${runtimeArgs.slice(1).join(" ")}\n`);
  const runtimeRun = runCommand("npm", runtimeArgs, {
    cwd: options.repoRoot,
    maxBufferBytes: toBufferBytes(options.maxBufferMb)
  });

  if (runtimeRun.error) {
    process.stderr.write(`${runtimeRun.error}\n`);
    process.exit(1);
  }

  const runtimeJson = extractStructuredJson(runtimeRun, isRuntimeResult);
  if (!runtimeJson) {
    process.stderr.write("Failed to parse runtime JSON output.\n");
    process.stderr.write(runtimeRun.stdout);
    process.stderr.write(runtimeRun.stderr);
    process.exit(1);
  }

  if (options.outputJson) {
    fs.mkdirSync(path.dirname(options.outputJson), { recursive: true });
    fs.writeFileSync(options.outputJson, `${JSON.stringify(runtimeJson, null, 2)}\n`, "utf8");
  }

  const summary = {
    mode: runtimeJson.mode ?? null,
    task_id: runtimeJson.task_id ?? options.taskId,
    reviewer_mode: runtimeJson.reviewer_mode ?? options.reviewerMode,
    cli_home_mode: runtimeJson.cli_home_mode ?? options.cliHomeMode,
    orchestrator_id: runtimeJson.orchestrator_id ?? null,
    aggregator_id: runtimeJson.aggregator_id ?? null,
    reviewer_agents: Array.isArray(runtimeJson.reviewer_agents) ? runtimeJson.reviewer_agents : [],
    receipt_count: runtimeJson.receipt_count ?? null,
    deadletter_aggregator: runtimeJson.deadletter_aggregator ?? null,
    deadletter_orchestrator: runtimeJson.deadletter_orchestrator ?? null,
    deadletter_by_agent: runtimeJson.deadletter_by_agent ?? null,
    quarantine_count: runtimeJson.quarantine_count ?? null,
    dedup_policy: runtimeJson.dedup_policy ?? null,
    operational_gate: runtimeJson.operational_gate ?? null,
    reviewer_failure_counts: runtimeJson.reviewer_failure_counts ?? null,
    final_decision: runtimeJson.final_decision ?? null,
    preflight: preflightSummary,
    runtime_status: runtimeRun.status ?? null,
    runtime_ok: runtimeRun.ok,
    output_json: options.outputJson || null
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!runtimeRun.ok) {
    process.exit(runtimeRun.status ?? 1);
  }
}

export {
  buildRuntimeArgs,
  extractJsonObjects,
  extractStructuredJson,
  isPreflightSummary,
  isRuntimeResult,
  parseArgs,
  toBufferBytes
};

const mainModulePath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isMain = mainModulePath ? import.meta.url === pathToFileURL(mainModulePath).href : false;
if (isMain) {
  main();
}
