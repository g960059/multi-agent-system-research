// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as cp from "node:child_process";
import { buildAcl, buildRuntimeAgentConfig, type ReviewerAgentProfile } from "./modules/agent-adapter";
import {
  signatureForEnvelope,
  validateEnvelope as validateEnvelopeWithPolicy
} from "./modules/envelope-policy";
import { FileMailbox, type ConsumedMessage } from "./modules/file-mailbox";
import { FileStateStore } from "./modules/file-state-store";

const DEFAULT_REVIEWER_PROMPT_FILES = {
  codex: "prompts/reviewer/codex.md",
  claude: "prompts/reviewer/claude.md"
};

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.max(1, Math.floor(maxChars * 0.75));
  const tail = Math.max(1, maxChars - head);
  const removed = value.length - head - tail;
  return `${value.slice(0, head)}\n\n...<truncated ${removed} chars>...\n\n${value.slice(value.length - tail)}`;
}

function runCommand(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs = 15000
): { ok: boolean; status: number | null; stdout: string; stderr: string; error?: string } {
  const run = cp.spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    ok: !run.error && run.status === 0,
    status: typeof run.status === "number" ? run.status : null,
    stdout: String(run.stdout ?? ""),
    stderr: String(run.stderr ?? ""),
    error: run.error ? String(run.error.message ?? run.error) : undefined
  };
}

export function validateEnvelope(
  envelope: any,
  options: {
    requireTaskIdMatch: boolean;
    taskIdMatchTypes: string[];
    acl?: {
      task_assignment: string[];
      review_result: string[];
      aggregation_result: string[];
      control: string[];
      error: string[];
    };
    aggregationResultTarget?: string;
  }
): { ok: boolean; code?: string; message?: string } {
  const acl =
    options?.acl ??
    buildAcl(
      buildRuntimeAgentConfig({
        reviewers: [
          { id: "codex", provider: "codex" },
          { id: "claude", provider: "claude" }
        ],
        orchestratorId: "orchestrator",
        aggregatorId: "aggregator"
      })
    );
  return validateEnvelopeWithPolicy(envelope, {
    requireTaskIdMatch: options.requireTaskIdMatch,
    taskIdMatchTypes: options.taskIdMatchTypes,
    acl,
    aggregationResultTarget: options?.aggregationResultTarget ?? "orchestrator"
  });
}

function parseJsonLenient(text: string): any {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("empty output");
  }

  // Direct JSON first.
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // Markdown fenced block.
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  // Best-effort object slice.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error("no JSON object found");
}

function toFindingArray(value: any, fieldName: string): any[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${fieldName}[${index}] must be an object`);
    }
    const code = String(item.code ?? "").trim();
    const title = String(item.title ?? "").trim();
    const detail = String(item.detail ?? "").trim();
    const severity = String(item.severity ?? "").trim();
    if (!code) {
      throw new Error(`${fieldName}[${index}].code is required`);
    }
    if (!title) {
      throw new Error(`${fieldName}[${index}].title is required`);
    }
    if (!detail) {
      throw new Error(`${fieldName}[${index}].detail is required`);
    }
    if (!["critical", "high", "medium", "low"].includes(severity)) {
      throw new Error(`${fieldName}[${index}].severity must be one of critical/high/medium/low`);
    }
    if (item.line !== undefined && (!Number.isInteger(item.line) || item.line <= 0)) {
      throw new Error(`${fieldName}[${index}].line must be a positive integer when provided`);
    }
    return {
      code,
      title,
      detail,
      file_path: typeof item.file_path === "string" ? item.file_path : undefined,
      line: Number.isInteger(item.line) && item.line > 0 ? item.line : undefined,
      severity
    };
  });
}

type ReviewerFailureCode = "REVIEWER_AUTH_ERROR" | "REVIEWER_NETWORK_ERROR" | "REVIEWER_EXECUTION_ERROR";

class ReviewerCliError extends Error {
  code: ReviewerFailureCode;
  rawOutputRef: string;

  constructor(code: ReviewerFailureCode, message: string, rawOutputRef: string) {
    super(message);
    this.code = code;
    this.rawOutputRef = rawOutputRef;
  }
}

function classifyReviewerFailure(text: string): ReviewerFailureCode {
  const s = String(text ?? "");
  if (
    /401 Unauthorized|Invalid API key|Missing bearer|Please run \/login|authentication/i.test(s)
  ) {
    return "REVIEWER_AUTH_ERROR";
  }
  if (/network error|stream disconnected|timed out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(s)) {
    return "REVIEWER_NETWORK_ERROR";
  }
  return "REVIEWER_EXECUTION_ERROR";
}

export class PocRuntime {
  readonly mailbox: FileMailbox;
  readonly state: FileStateStore;
  readonly stateRoot: string;
  readonly orchestratorId: string;
  readonly aggregatorId: string;
  readonly reviewerProfiles: ReviewerAgentProfile[];
  readonly reviewerProfileById: Record<string, ReviewerAgentProfile>;
  readonly principalIds: string[];
  readonly requiredAgents: string[];
  readonly validationOptions: {
    requireTaskIdMatch: boolean;
    taskIdMatchTypes: string[];
    acl: {
      task_assignment: string[];
      review_result: string[];
      aggregation_result: string[];
      control: string[];
      error: string[];
    };
    aggregationResultTarget: string;
  };
  readonly reviewerMode: "deterministic" | "cli";
  readonly cliTimeoutMs: number;
  readonly repoRoot: string;
  readonly promptByProvider: Record<"codex" | "claude", string>;
  readonly promptByReviewerId: Record<string, string>;
  readonly rawOutputDir: string;
  readonly cliHomeDir: string;
  readonly artifactDir: string;
  readonly reviewSchemaPath: string;
  readonly codexOutputSchemaPath: string;
  readonly reviewSchemaJson: string;
  readonly reviewInputMaxChars: number;
  readonly reviewInputExcerptChars: number;
  readonly reviewInputIncludeDiff: boolean;
  readonly cliHomeMode: "isolated" | "host";

  constructor(options?: {
    mailboxRoot?: string;
    stateRoot?: string;
    requiredAgents?: string[];
    requireTaskIdMatch?: boolean;
    taskIdMatchTypes?: string[];
    reviewerMode?: "deterministic" | "cli";
    cliTimeoutMs?: number;
    repoRoot?: string;
    codexModel?: string;
    claudeModel?: string;
    reviewers?: ReviewerAgentProfile[];
    orchestratorId?: string;
    aggregatorId?: string;
    reviewInputMaxChars?: number;
    reviewInputExcerptChars?: number;
    reviewInputIncludeDiff?: boolean;
    cliHomeMode?: "isolated" | "host";
  }) {
    const mailboxRoot = options?.mailboxRoot ?? path.resolve("tmp/poc-mailbox/mailbox");
    const stateRoot = options?.stateRoot ?? path.resolve("tmp/poc-mailbox/state");
    const repoRoot = options?.repoRoot ?? process.cwd();
    this.mailbox = new FileMailbox(mailboxRoot);
    this.state = new FileStateStore(stateRoot);
    this.stateRoot = stateRoot;
    const agentConfig = buildRuntimeAgentConfig({
      orchestratorId: options?.orchestratorId,
      aggregatorId: options?.aggregatorId,
      reviewers: options?.reviewers,
      codexModel: options?.codexModel,
      claudeModel: options?.claudeModel
    });
    this.orchestratorId = agentConfig.orchestrator_id;
    this.aggregatorId = agentConfig.aggregator_id;
    this.reviewerProfiles = [...agentConfig.reviewers];
    this.reviewerProfileById = {};
    for (const reviewer of this.reviewerProfiles) {
      this.reviewerProfileById[reviewer.id] = reviewer;
    }
    this.principalIds = [this.orchestratorId, this.aggregatorId, ...this.reviewerProfiles.map((x) => x.id)];
    this.requiredAgents = options?.requiredAgents ?? this.reviewerProfiles.map((x) => x.id);
    for (const agentId of this.requiredAgents) {
      if (!this.reviewerProfileById[agentId]) {
        throw new Error(`requiredAgents contains unknown reviewer id: ${agentId}`);
      }
    }
    const acl = buildAcl(agentConfig);
    this.validationOptions = {
      requireTaskIdMatch: options?.requireTaskIdMatch ?? true,
      taskIdMatchTypes: options?.taskIdMatchTypes ?? ["review_result", "aggregation_result"],
      acl,
      aggregationResultTarget: this.orchestratorId
    };
    this.reviewerMode = options?.reviewerMode ?? "deterministic";
    this.cliTimeoutMs = options?.cliTimeoutMs ?? 120000;
    this.repoRoot = repoRoot;
    this.reviewSchemaPath = path.resolve(repoRoot, "schemas/poc/review-result.v1.schema.json");
    this.codexOutputSchemaPath = path.resolve(repoRoot, "schemas/poc/review-result.v1.codex-output.schema.json");
    this.reviewSchemaJson = JSON.stringify(readJson(this.reviewSchemaPath));
    this.reviewInputMaxChars = Math.max(20000, Number(options?.reviewInputMaxChars ?? 120000));
    this.reviewInputExcerptChars = Math.max(4000, Number(options?.reviewInputExcerptChars ?? 24000));
    this.reviewInputIncludeDiff = options?.reviewInputIncludeDiff ?? false;
    this.cliHomeMode = options?.cliHomeMode ?? "isolated";
    this.promptByProvider = {
      codex: fs.readFileSync(path.resolve(repoRoot, DEFAULT_REVIEWER_PROMPT_FILES.codex), "utf8"),
      claude: fs.readFileSync(path.resolve(repoRoot, DEFAULT_REVIEWER_PROMPT_FILES.claude), "utf8")
    };
    this.promptByReviewerId = {};
    for (const reviewer of this.reviewerProfiles) {
      if (reviewer.prompt_file) {
        this.promptByReviewerId[reviewer.id] = fs.readFileSync(path.resolve(repoRoot, reviewer.prompt_file), "utf8");
        continue;
      }
      this.promptByReviewerId[reviewer.id] = this.promptByProvider[reviewer.provider];
    }
    this.rawOutputDir = path.join(stateRoot, "raw-cli-output");
    this.cliHomeDir = path.join(stateRoot, "cli-home");
    this.artifactDir = path.join(stateRoot, "artifacts");
  }

  init(): void {
    this.mailbox.init(this.principalIds);
    this.state.init();
    ensureDir(this.rawOutputDir);
    ensureDir(this.cliHomeDir);
    ensureDir(this.artifactDir);
  }

  createEnvelope(input: {
    taskId: string;
    senderId: string;
    to: string;
    type: string;
    payload: any;
    stateVersion?: number;
    parentId?: string;
    msgId?: string;
  }): any {
    const createdAt = nowIso();
    const envelope = {
      msg_id: input.msgId ?? crypto.randomUUID(),
      schema_version: 1,
      task_id: input.taskId,
      sender_id: input.senderId,
      sender_instance_id: `${input.senderId}-instance-1`,
      key_id: `k-${input.senderId}-v1`,
      issued_at: createdAt,
      nonce: crypto.randomUUID(),
      signature: "",
      from: input.senderId,
      to: input.to,
      type: input.type,
      state_version: input.stateVersion ?? 1,
      delivery_attempt: 1,
      created_at: createdAt,
      payload: input.payload
    };
    if (input.parentId) {
      envelope.parent_id = input.parentId;
    }
    envelope.signature = signatureForEnvelope(envelope);
    return envelope;
  }

  private captureReviewInput(taskId: string, instruction: string): {
    reviewInputRef: string;
    reviewInputExcerpt: string;
    reviewInputSource: string;
  } {
    const sections: string[] = [];
    const add = (title: string, body: string) => {
      const value = String(body ?? "").trim();
      sections.push(`## ${title}\n${value || "(empty)"}`);
    };

    add(
      "meta",
      [
        `task_id: ${taskId}`,
        `generated_at: ${nowIso()}`,
        `repo_root: ${this.repoRoot}`,
        `detail_level: ${this.reviewInputIncludeDiff ? "full_diff" : "summary_only"}`
      ].join("\n")
    );
    add("instruction", instruction);

    const gitProbe = runCommand(this.repoRoot, "git", ["rev-parse", "--is-inside-work-tree"], 6000);
    const insideGit = gitProbe.ok && gitProbe.stdout.trim() === "true";
    if (!insideGit) {
      add(
        "git_probe",
        [
          `status: ${gitProbe.status}`,
          `stdout:\n${gitProbe.stdout || "(none)"}`,
          `stderr:\n${gitProbe.stderr || "(none)"}`,
          gitProbe.error ? `error:\n${gitProbe.error}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
      const fallback = sections.join("\n\n");
      const filePath = this.writeReviewInputArtifact(taskId, truncateText(fallback, this.reviewInputMaxChars));
      return {
        reviewInputRef: filePath,
        reviewInputExcerpt: truncateText(fallback, this.reviewInputExcerptChars),
        reviewInputSource: "instruction_only"
      };
    }

    const appendCommand = (title: string, args: string[], timeoutMs = 12000) => {
      const run = runCommand(this.repoRoot, "git", args, timeoutMs);
      const output = [
        `cmd: git ${args.map((x) => JSON.stringify(x)).join(" ")}`,
        `status: ${run.status}`,
        run.error ? `error:\n${run.error}` : "",
        `stdout:\n${run.stdout || "(none)"}`,
        `stderr:\n${run.stderr || "(none)"}`
      ]
        .filter(Boolean)
        .join("\n");
      add(title, output);
    };

    appendCommand("git_branch", ["rev-parse", "--abbrev-ref", "HEAD"], 6000);
    appendCommand("git_head", ["rev-parse", "HEAD"], 6000);
    appendCommand("git_status", ["status", "--short", "--untracked-files=all"], 12000);
    appendCommand("git_diff_stat_worktree", ["diff", "--no-color", "--stat", "--", "."], 12000);
    appendCommand("git_diff_stat_staged", ["diff", "--cached", "--no-color", "--stat", "--", "."], 12000);
    appendCommand("git_untracked_files", ["ls-files", "--others", "--exclude-standard"], 12000);
    if (this.reviewInputIncludeDiff) {
      appendCommand("git_diff_worktree", ["diff", "--no-color", "--", "."], 20000);
      appendCommand("git_diff_staged", ["diff", "--cached", "--no-color", "--", "."], 20000);
    }

    const full = sections.join("\n\n");
    const capped = truncateText(full, this.reviewInputMaxChars);
    const filePath = this.writeReviewInputArtifact(taskId, capped);
    return {
      reviewInputRef: filePath,
      reviewInputExcerpt: truncateText(capped, this.reviewInputExcerptChars),
      reviewInputSource: "git_working_tree"
    };
  }

  private writeReviewInputArtifact(taskId: string, text: string): string {
    const dirPath = path.join(this.artifactDir, taskId);
    ensureDir(dirPath);
    const filePath = path.join(dirPath, "review-input.md");
    fs.writeFileSync(filePath, `${String(text ?? "")}\n`, "utf8");
    return filePath;
  }

  seedTask(taskId: string, instruction: string): string[] {
    const reviewInput = this.captureReviewInput(taskId, instruction);
    const msgIds: string[] = [];
    for (const reviewer of this.reviewerProfiles) {
      const reviewerInstruction = reviewer.instruction
        ? `${instruction}\n\nReviewer focus (${reviewer.id}): ${reviewer.instruction}`
        : instruction;
      const assignmentPayload = {
        review_request_ref: `artifact://${taskId}/review-request.md`,
        review_input_ref: reviewInput.reviewInputRef,
        review_input_source: reviewInput.reviewInputSource,
        review_input_excerpt: reviewInput.reviewInputExcerpt,
        reviewer_model_hint: reviewer.model,
        reviewer_profile: {
          id: reviewer.id,
          provider: reviewer.provider,
          model: reviewer.model ?? null,
          instruction: reviewer.instruction ?? null,
          display_name: reviewer.display_name ?? null
        },
        required_agents: [...this.requiredAgents],
        instruction: reviewerInstruction
      };
      const envelope = this.createEnvelope({
        taskId,
        senderId: this.orchestratorId,
        to: reviewer.id,
        type: "task_assignment",
        payload: assignmentPayload,
        stateVersion: 1
      });
      this.mailbox.publish(envelope);
      msgIds.push(envelope.msg_id);
    }
    return msgIds;
  }

  private handleInvalid(item: ConsumedMessage, validation: { code?: string; message?: string }): void {
    this.state.appendQuarantine({
      task_id: item.envelope.task_id,
      sender_id: item.envelope.sender_id,
      msg_id: item.envelope.msg_id,
      type: item.envelope.type,
      code: validation.code ?? "VALIDATION_FAILED",
      message: validation.message ?? "invalid message"
    });
    this.mailbox.nack(item, validation.code ?? "VALIDATION_FAILED");
  }

  private writeRawCliOutput(taskId: string, reviewerId: string, text: string): string {
    const filePath = path.join(this.rawOutputDir, `${taskId}--${reviewerId}--${Date.now()}.txt`);
    fs.writeFileSync(filePath, text, "utf8");
    return filePath;
  }

  private buildReviewerPrompt(reviewer: ReviewerAgentProfile, assignmentEnvelope: any): string {
    const basePrompt = this.promptByReviewerId[reviewer.id] ?? this.promptByProvider[reviewer.provider];
    const instruction = String(assignmentEnvelope?.payload?.instruction ?? "");
    const taskId = String(assignmentEnvelope?.task_id ?? "");
    const reviewInputRef = String(assignmentEnvelope?.payload?.review_input_ref ?? "");
    const reviewInputSource = String(assignmentEnvelope?.payload?.review_input_source ?? "");
    const reviewInputExcerpt = String(assignmentEnvelope?.payload?.review_input_excerpt ?? "");
    const schemaRef = "schemas/poc/review-result.v1.schema.json";
    return [
      basePrompt.trim(),
      "",
      "Additional constraints for runtime adapter:",
      "- Return only JSON object.",
      "- Keep schema_version=1 and include all required fields.",
      `- Set task_id exactly to "${taskId}".`,
      "- Do not execute shell commands or any external tools.",
      `- reviewer_id: ${reviewer.id}`,
      `- provider: ${reviewer.provider}`,
      `- model_hint: ${reviewer.model ?? "(none)"}`,
      "",
      "Assignment:",
      instruction,
      "",
      "Review context:",
      `- review_input_ref: ${reviewInputRef || "(none)"}`,
      `- review_input_source: ${reviewInputSource || "(none)"}`,
      "",
      "Review input excerpt (truncated):",
      reviewInputExcerpt || "(none)",
      "",
      `Schema ref: ${schemaRef}`
    ].join("\n");
  }

  private renderCommandTemplateToken(token: string, values: Record<string, string>): string {
    return String(token ?? "").replace(/\{([a-z0-9_]+)\}/gi, (_, name: string) => values[name] ?? "");
  }

  private commandFromTemplate(
    template: string[],
    values: Record<string, string>
  ): { cmd: string; args: string[]; includesPromptPlaceholder: boolean } {
    const includesPromptPlaceholder = template.some((token) => String(token ?? "").includes("{prompt}"));
    const resolved = template
      .map((token) => this.renderCommandTemplateToken(token, values).trim())
      .filter(Boolean);
    if (resolved.length === 0) {
      throw new Error("reviewer command_template resolved to empty command");
    }
    return {
      cmd: resolved[0],
      args: resolved.slice(1),
      includesPromptPlaceholder
    };
  }

  private buildReviewerCommand(
    reviewer: ReviewerAgentProfile,
    prompt: string
  ): { cmd: string; args: string[] } {
    const values = {
      repo_root: this.repoRoot,
      prompt,
      model: reviewer.model ?? "",
      codex_output_schema_path: this.codexOutputSchemaPath,
      review_schema_json: this.reviewSchemaJson
    };

    if (Array.isArray(reviewer.command_template) && reviewer.command_template.length > 0) {
      const fromTemplate = this.commandFromTemplate(reviewer.command_template, values);
      let args = [...fromTemplate.args];
      if (!fromTemplate.includesPromptPlaceholder) {
        args.push(prompt);
      }

      const cmdBase = path.basename(fromTemplate.cmd).toLowerCase();
      if (reviewer.provider === "codex" && cmdBase === "codex") {
        if (!args.includes("--skip-git-repo-check")) {
          args.push("--skip-git-repo-check");
        }
        if (!args.includes("--output-schema")) {
          args.push("--output-schema", this.codexOutputSchemaPath);
        }
        if (reviewer.model && !args.includes("--model")) {
          const execIndex = args.indexOf("exec");
          if (execIndex === -1) {
            args.push("--model", reviewer.model);
          } else {
            args.splice(execIndex + 1, 0, "--model", reviewer.model);
          }
        }
      } else if (reviewer.provider === "claude" && cmdBase === "claude") {
        if (!args.includes("--output-format")) {
          args.push("--output-format", "json");
        }
        if (!args.includes("--json-schema")) {
          args.push("--json-schema", this.reviewSchemaJson);
        }
        if (reviewer.model && !args.includes("--model")) {
          args.push("--model", reviewer.model);
        }
      }

      return {
        cmd: fromTemplate.cmd,
        args
      };
    }

    if (reviewer.provider === "codex") {
      const args = [
        "exec",
        "--sandbox",
        "read-only",
        "--cd",
        this.repoRoot,
        "--skip-git-repo-check",
        "--output-schema",
        this.codexOutputSchemaPath,
        prompt
      ];
      if (reviewer.model) {
        args.splice(1, 0, "--model", reviewer.model);
      }
      return { cmd: "codex", args };
    }

    const args = ["-p", prompt, "--output-format", "json", "--json-schema", this.reviewSchemaJson];
    if (reviewer.model) {
      args.push("--model", reviewer.model);
    }
    return { cmd: "claude", args };
  }

  private buildCliEnv(reviewer?: ReviewerAgentProfile): NodeJS.ProcessEnv {
    const reviewerEnv =
      reviewer?.env && typeof reviewer.env === "object"
        ? Object.fromEntries(
            Object.entries(reviewer.env)
              .map(([k, v]) => [String(k ?? "").trim(), String(v ?? "")])
              .filter(([k]) => Boolean(k))
          )
        : {};
    if (this.cliHomeMode === "host") {
      return { ...process.env, ...reviewerEnv };
    }
    const xdgConfig = path.join(this.cliHomeDir, ".config");
    const xdgCache = path.join(this.cliHomeDir, ".cache");
    const xdgState = path.join(this.cliHomeDir, ".state");
    const xdgData = path.join(this.cliHomeDir, ".local", "share");
    for (const dirPath of [xdgConfig, xdgCache, xdgState, xdgData, path.join(this.cliHomeDir, ".codex"), path.join(this.cliHomeDir, ".claude")]) {
      ensureDir(dirPath);
    }
    return {
      ...process.env,
      ...reviewerEnv,
      HOME: this.cliHomeDir,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      XDG_DATA_HOME: xdgData
    };
  }

  private executeReviewerCli(
    reviewer: ReviewerAgentProfile,
    assignmentEnvelope: any
  ): { payload: any; rawOutputRef: string } {
    const prompt = this.buildReviewerPrompt(reviewer, assignmentEnvelope);
    const env = this.buildCliEnv(reviewer);
    const reviewerCommand = this.buildReviewerCommand(reviewer, prompt);
    const cmd = reviewerCommand.cmd;
    const args = reviewerCommand.args;

    const run = cp.spawnSync(cmd, args, {
      cwd: this.repoRoot,
      env,
      encoding: "utf8",
      timeout: this.cliTimeoutMs,
      maxBuffer: 10 * 1024 * 1024
    });

    const rawText = [
      `cmd: ${cmd} ${args.map((x) => JSON.stringify(x)).join(" ")}`,
      `status: ${String(run.status)}`,
      "stdout:",
      String(run.stdout ?? ""),
      "stderr:",
      String(run.stderr ?? "")
    ].join("\n");
    const rawOutputRef = this.writeRawCliOutput(assignmentEnvelope.task_id, reviewer.id, rawText);

    if (run.error) {
      const message = `${reviewer.id} execution error: ${String(run.error.message ?? run.error)} (raw=${rawOutputRef})`;
      throw new ReviewerCliError(classifyReviewerFailure(message), message, rawOutputRef);
    }
    if (typeof run.status === "number" && run.status !== 0) {
      const message = `${reviewer.id} exited with status=${run.status}\nstdout=${String(run.stdout ?? "")}\nstderr=${String(
        run.stderr ?? ""
      )}\nraw=${rawOutputRef}`;
      throw new ReviewerCliError(classifyReviewerFailure(message), message, rawOutputRef);
    }

    let parsed = parseJsonLenient(String(run.stdout ?? ""));
    if (reviewer.provider === "claude" && parsed && typeof parsed === "object") {
      if (typeof parsed.result === "string") {
        parsed = parseJsonLenient(parsed.result);
      } else if (Array.isArray(parsed.content)) {
        const textParts = parsed.content.map((chunk: any) => chunk?.text ?? "").join("\n");
        if (textParts.trim()) {
          parsed = parseJsonLenient(textParts);
        }
      }
    }
    return { payload: parsed, rawOutputRef };
  }

  private normalizeReviewPayload(
    reviewer: ReviewerAgentProfile,
    taskId: string,
    payload: any,
    rawOutputRef: string
  ): any {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("reviewer output must be a JSON object");
    }
    const payloadTaskId = String(payload.task_id ?? "").trim();
    if (!payloadTaskId) {
      throw new Error("review payload.task_id is required");
    }
    if (payloadTaskId !== taskId) {
      throw new Error(`review payload.task_id mismatch: expected=${taskId}, got=${payloadTaskId}`);
    }
    const model = String(payload.model ?? "").trim();
    if (!model) {
      throw new Error("review payload.model is required");
    }
    const verdict = String(payload.verdict ?? "").trim();
    if (!["PASS", "FAIL"].includes(verdict)) {
      throw new Error("review payload.verdict must be PASS or FAIL");
    }
    const blocking = toFindingArray(payload.blocking, "blocking");
    const nonBlocking = toFindingArray(payload.non_blocking, "non_blocking");
    const summary = String(payload.summary ?? "").trim();
    if (!summary) {
      throw new Error("review payload.summary is required");
    }
    const confidence = String(payload.confidence ?? "").trim();
    if (!["high", "medium", "low"].includes(confidence)) {
      throw new Error("review payload.confidence must be high/medium/low");
    }
    const nextAction = String(payload.next_action ?? "").trim();
    if (!["proceed", "rework", "manual_review_required"].includes(nextAction)) {
      throw new Error("review payload.next_action must be proceed/rework/manual_review_required");
    }
    const generatedAt = String(payload.generated_at ?? "").trim();
    if (!generatedAt || Number.isNaN(new Date(generatedAt).getTime())) {
      throw new Error("review payload.generated_at must be a valid ISO date-time");
    }
    const normalizedRawOutputRef = String(payload.raw_output_ref ?? rawOutputRef).trim();
    if (!normalizedRawOutputRef) {
      throw new Error("review payload.raw_output_ref is required");
    }

    return {
      schema_version: 1,
      task_id: taskId,
      model,
      verdict,
      blocking,
      non_blocking: nonBlocking,
      summary,
      confidence,
      next_action: nextAction,
      generated_at: generatedAt,
      raw_output_ref: normalizedRawOutputRef
    };
  }

  processReviewer(reviewerId: string): number {
    const reviewer = this.reviewerProfileById[reviewerId];
    if (!reviewer) {
      throw new Error(`Unknown reviewer: ${reviewerId}`);
    }
    let actions = 0;
    const messages = this.mailbox.consume(reviewerId, 100);
    for (const item of messages) {
      const validation = validateEnvelope(item.envelope, this.validationOptions);
      if (!validation.ok) {
        this.handleInvalid(item, validation);
        actions += 1;
        continue;
      }

      const inserted = this.state.insertReceipt(
        item.envelope.task_id,
        item.envelope.sender_id,
        item.envelope.msg_id,
        item.envelope.type
      );
      this.mailbox.ack(item);
      actions += 1;
      if (!inserted) {
        continue;
      }
      if (item.envelope.type !== "task_assignment") {
        continue;
      }

      // Pull model: execution starts only after assignment receipt + ack.
      let reviewPayload: any;
      if (this.reviewerMode === "cli") {
        try {
          const cli = this.executeReviewerCli(reviewer, item.envelope);
          reviewPayload = this.normalizeReviewPayload(reviewer, item.envelope.task_id, cli.payload, cli.rawOutputRef);
        } catch (error) {
          const errCode =
            error instanceof ReviewerCliError ? error.code : "REVIEWER_EXECUTION_ERROR";
          const rawOutputRef =
            error instanceof ReviewerCliError
              ? error.rawOutputRef
              : `artifact://${item.envelope.task_id}/${reviewer.id}/execution-error/${Date.now()}`;
          reviewPayload = {
            schema_version: 1,
            task_id: item.envelope.task_id,
            model: reviewer.model ?? (reviewer.provider === "codex" ? "gpt-5-codex" : "claude-sonnet"),
            verdict: "FAIL",
            blocking: [
              {
                code: errCode,
                title: "Reviewer CLI execution failed",
                detail: String(error),
                severity: "high"
              }
            ],
            non_blocking: [],
            summary: `${reviewer.id} CLI execution failed`,
            confidence: "medium",
            next_action: "manual_review_required",
            generated_at: nowIso(),
            raw_output_ref: rawOutputRef
          };
        }
      } else {
        const instruction = String(item.envelope?.payload?.instruction ?? "");
        const forceFail = instruction.includes(`force-fail:${reviewer.id}`);
        const blocking = forceFail
          ? [
              {
                code: "TEST_MISSING",
                title: "Critical Test Missing",
                detail: "Required regression test is missing",
                severity: "high"
              }
            ]
          : [];

        reviewPayload = {
          schema_version: 1,
          task_id: item.envelope.task_id,
          model: reviewer.model ?? (reviewer.provider === "codex" ? "gpt-5-codex" : "claude-sonnet"),
          verdict: forceFail ? "FAIL" : "PASS",
          blocking,
          non_blocking: [],
          summary: forceFail ? `${reviewer.id} found blocking issue` : `${reviewer.id} review passed`,
          confidence: "high",
          next_action: forceFail ? "rework" : "proceed",
          generated_at: nowIso(),
          raw_output_ref: `artifact://${item.envelope.task_id}/${reviewer.id}/${Date.now()}`
        };
      }

      const reviewEnvelope = this.createEnvelope({
        taskId: item.envelope.task_id,
        senderId: reviewer.id,
        to: this.aggregatorId,
        type: "review_result",
        payload: reviewPayload,
        stateVersion: item.envelope.state_version + 1,
        parentId: item.envelope.msg_id
      });
      this.mailbox.publish(reviewEnvelope);
      actions += 1;
    }
    return actions;
  }

  processAggregator(): number {
    let actions = 0;
    const messages = this.mailbox.consume(this.aggregatorId, 100);
    for (const item of messages) {
      const validation = validateEnvelope(item.envelope, this.validationOptions);
      if (!validation.ok) {
        this.handleInvalid(item, validation);
        actions += 1;
        continue;
      }

      const inserted = this.state.insertReceipt(
        item.envelope.task_id,
        item.envelope.sender_id,
        item.envelope.msg_id,
        item.envelope.type
      );
      this.mailbox.ack(item);
      actions += 1;
      if (!inserted) {
        continue;
      }
      if (item.envelope.type !== "review_result") {
        continue;
      }

      this.state.recordReview(item.envelope.task_id, item.envelope.sender_id, item.envelope.payload, item.envelope.msg_id);
      const reviews = this.state.getReviews(item.envelope.task_id);
      const receivedAgents = Object.keys(reviews).sort();
      const quorumReached = this.requiredAgents.every((agent) => receivedAgents.includes(agent));
      if (!quorumReached) {
        continue;
      }
      if (!this.state.canPublishAggregation(item.envelope.task_id)) {
        continue;
      }

      const reviewRows = this.requiredAgents.map((agent) => reviews[agent]).filter(Boolean);
      const anyFail = reviewRows.some((row) => row.verdict === "FAIL" || row.blocking_count > 0);
      const anyExecutionError = reviewRows.some((row) => row.has_execution_error === true);
      const allVerdicts = new Set(reviewRows.map((row) => row.verdict));
      const disagree = allVerdicts.size > 1;
      const blockingCount = reviewRows.reduce((sum, row) => sum + Number(row.blocking_count ?? 0), 0);
      const verdict = anyFail ? "FAIL" : "PASS";
      const nextAction = anyExecutionError
        ? "manual_review_required"
        : disagree
        ? "manual_review_required"
        : verdict === "PASS"
        ? "proceed"
        : "rework";

      const aggregationPayload = {
        schema_version: 1,
        task_id: item.envelope.task_id,
        required_agents: [...this.requiredAgents],
        received_agents: [...receivedAgents],
        quorum_reached: true,
        verdict,
        blocking_count: blockingCount,
        disagree,
        next_action: nextAction,
        generated_at: nowIso(),
        source_msg_ids: reviewRows.map((row) => row.msg_id)
      };

      const aggregationEnvelope = this.createEnvelope({
        taskId: item.envelope.task_id,
        senderId: this.aggregatorId,
        to: this.orchestratorId,
        type: "aggregation_result",
        payload: aggregationPayload,
        stateVersion: item.envelope.state_version + 1,
        parentId: item.envelope.msg_id
      });
      this.mailbox.publish(aggregationEnvelope);
      this.state.markAggregationPublished(item.envelope.task_id, aggregationEnvelope.msg_id);
      actions += 1;
    }
    return actions;
  }

  processOrchestrator(): number {
    let actions = 0;
    const messages = this.mailbox.consume(this.orchestratorId, 100);
    for (const item of messages) {
      const validation = validateEnvelope(item.envelope, this.validationOptions);
      if (!validation.ok) {
        this.handleInvalid(item, validation);
        actions += 1;
        continue;
      }
      const inserted = this.state.insertReceipt(
        item.envelope.task_id,
        item.envelope.sender_id,
        item.envelope.msg_id,
        item.envelope.type
      );
      this.mailbox.ack(item);
      actions += 1;
      if (!inserted) {
        continue;
      }
      if (item.envelope.type !== "aggregation_result") {
        continue;
      }
      this.state.setFinalDecision(item.envelope.task_id, {
        task_id: item.envelope.task_id,
        verdict: item.envelope.payload.verdict,
        next_action: item.envelope.payload.next_action,
        blocking_count: item.envelope.payload.blocking_count,
        disagree: item.envelope.payload.disagree,
        decided_at: nowIso()
      });
      actions += 1;
    }
    return actions;
  }

  runOnePass(): number {
    let actions = 0;
    for (const reviewer of this.reviewerProfiles) {
      actions += this.processReviewer(reviewer.id);
    }
    actions += this.processAggregator();
    actions += this.processOrchestrator();
    return actions;
  }

  runUntilStable(maxPasses = 10): { passes: number; totalActions: number } {
    let totalActions = 0;
    let passes = 0;
    while (passes < maxPasses) {
      passes += 1;
      const actions = this.runOnePass();
      totalActions += actions;
      if (actions === 0) {
        break;
      }
    }
    return { passes, totalActions };
  }

  duplicateFirstInboxMessage(agentId: string): string | null {
    const messages = this.mailbox.peek(agentId);
    if (messages.length === 0) {
      return null;
    }
    const duplicated = messages[0].envelope;
    this.mailbox.publish(duplicated);
    return duplicated.msg_id;
  }

  injectTaskIdMismatchReview(taskId: string, payloadTaskId: string): string {
    const senderId = this.reviewerProfiles[0]?.id ?? "codex";
    const sender = this.reviewerProfileById[senderId];
    const payload = {
      schema_version: 1,
      task_id: payloadTaskId,
      model: sender?.model ?? (sender?.provider === "claude" ? "claude-sonnet" : "gpt-5-codex"),
      verdict: "PASS",
      blocking: [],
      non_blocking: [],
      summary: "malformed message for validation test",
      confidence: "high",
      next_action: "proceed",
      generated_at: nowIso(),
      raw_output_ref: `artifact://${taskId}/malformed`
    };
    const envelope = this.createEnvelope({
      taskId,
      senderId,
      to: this.aggregatorId,
      type: "review_result",
      payload,
      stateVersion: 9
    });
    this.mailbox.publish(envelope);
    return envelope.msg_id;
  }

  getFinalDecision(taskId: string): any | null {
    return this.state.getFinalDecision(taskId);
  }

  getQuarantineRows(): any[] {
    return this.state.readQuarantineRows();
  }

  getReceiptCount(): number {
    return this.state.receiptCount();
  }

  getReviewerFailureCounts(taskId: string): {
    auth_error: number;
    network_error: number;
    execution_error: number;
    total: number;
  } {
    return this.state.getReviewerFailureCounts(taskId);
  }

  deadletterCount(agentId: string): number {
    return this.mailbox.deadletterCount(agentId);
  }

  getReviewerProfiles(): ReviewerAgentProfile[] {
    return [...this.reviewerProfiles];
  }

  getOrchestratorId(): string {
    return this.orchestratorId;
  }

  getAggregatorId(): string {
    return this.aggregatorId;
  }

  getDeadletterCounts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const principalId of this.principalIds) {
      result[principalId] = this.deadletterCount(principalId);
    }
    return result;
  }
}
