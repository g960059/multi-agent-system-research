// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as cp from "node:child_process";

const REVIEWERS = ["codex", "claude"];
const PRINCIPALS = ["orchestrator", "codex", "claude", "aggregator"];

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath: string, value: any): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(filePath: string, value: any): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
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
  const canonical = stableStringify(target);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function senderAllowedByType(type: string, senderId: string): boolean {
  if (type === "task_assignment") {
    return senderId === "orchestrator";
  }
  if (type === "review_result") {
    return senderId === "codex" || senderId === "claude";
  }
  if (type === "aggregation_result") {
    return senderId === "aggregator";
  }
  if (type === "control") {
    return senderId === "orchestrator";
  }
  if (type === "error") {
    return PRINCIPALS.includes(senderId);
  }
  return false;
}

export function validateEnvelope(
  envelope: any,
  options: {
    requireTaskIdMatch: boolean;
    taskIdMatchTypes: string[];
  }
): { ok: boolean; code?: string; message?: string } {
  if (envelope.from !== envelope.sender_id) {
    return { ok: false, code: "SENDER_ID_MISMATCH", message: "from must equal sender_id" };
  }
  if (!senderAllowedByType(envelope.type, envelope.sender_id)) {
    return { ok: false, code: "ACL_DENY", message: `sender ${envelope.sender_id} cannot publish ${envelope.type}` };
  }
  if (envelope.type === "aggregation_result" && envelope.to !== "orchestrator") {
    return { ok: false, code: "INVALID_ROUTE", message: "aggregation_result must target orchestrator" };
  }
  const expectedSignature = signatureForEnvelope(envelope);
  if (envelope.signature !== expectedSignature) {
    return { ok: false, code: "SIGNATURE_INVALID", message: "signature verification failed" };
  }
  if (options.requireTaskIdMatch && options.taskIdMatchTypes.includes(envelope.type)) {
    const payloadTaskId = envelope?.payload?.task_id;
    if (payloadTaskId !== envelope.task_id) {
      return { ok: false, code: "TASK_ID_MISMATCH", message: "envelope.task_id must equal payload.task_id" };
    }
  }
  return { ok: true };
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

function toFindingArray(value: any): any[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => {
    const severity = ["critical", "high", "medium", "low"].includes(item?.severity) ? item.severity : "medium";
    return {
      code: String(item?.code ?? `AUTO_${index + 1}`),
      title: String(item?.title ?? "Auto normalized finding"),
      detail: String(item?.detail ?? "No detail provided by reviewer output"),
      file_path: typeof item?.file_path === "string" ? item.file_path : undefined,
      line: Number.isInteger(item?.line) && item.line > 0 ? item.line : undefined,
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

type ConsumedMessage = {
  agentId: string;
  filePath: string;
  envelope: any;
};

export class FileMailbox {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  init(agents: string[]): void {
    ensureDir(this.rootDir);
    ensureDir(path.join(this.rootDir, "inbox"));
    ensureDir(path.join(this.rootDir, "ack"));
    ensureDir(path.join(this.rootDir, "deadletter"));
    for (const agent of agents) {
      ensureDir(path.join(this.rootDir, "inbox", agent));
      ensureDir(path.join(this.rootDir, "ack", agent));
      ensureDir(path.join(this.rootDir, "deadletter", agent));
    }
  }

  publish(envelope: any): string {
    const inboxDir = path.join(this.rootDir, "inbox", envelope.to);
    ensureDir(inboxDir);
    const fileName = `${envelope.msg_id}--${Date.now()}--${crypto.randomUUID()}.json`;
    const filePath = path.join(inboxDir, fileName);
    writeJson(filePath, envelope);
    return filePath;
  }

  consume(agentId: string, limit: number): ConsumedMessage[] {
    const inboxDir = path.join(this.rootDir, "inbox", agentId);
    ensureDir(inboxDir);
    const files = fs
      .readdirSync(inboxDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, limit);
    return files.map((name) => {
      const filePath = path.join(inboxDir, name);
      return {
        agentId,
        filePath,
        envelope: readJson(filePath)
      };
    });
  }

  peek(agentId: string): ConsumedMessage[] {
    return this.consume(agentId, Number.MAX_SAFE_INTEGER);
  }

  ack(item: ConsumedMessage): void {
    const dstDir = path.join(this.rootDir, "ack", item.agentId);
    ensureDir(dstDir);
    const dstPath = path.join(dstDir, path.basename(item.filePath));
    fs.renameSync(item.filePath, dstPath);
  }

  nack(item: ConsumedMessage, reason: string): void {
    const dstDir = path.join(this.rootDir, "deadletter", item.agentId);
    ensureDir(dstDir);
    const dstPath = path.join(dstDir, path.basename(item.filePath));
    const wrapped = {
      reason,
      quarantined_at: nowIso(),
      envelope: item.envelope
    };
    writeJson(dstPath, wrapped);
    fs.unlinkSync(item.filePath);
  }

  deadletterCount(agentId: string): number {
    const dir = path.join(this.rootDir, "deadletter", agentId);
    if (!fs.existsSync(dir)) {
      return 0;
    }
    return fs.readdirSync(dir).filter((x) => x.endsWith(".json")).length;
  }
}

export class FileStateStore {
  private readonly rootDir: string;
  private readonly receiptsPath: string;
  private readonly quarantinePath: string;
  private readonly taskStatePath: string;
  private readonly reviewCachePath: string;
  private readonly receipts: Set<string> = new Set();
  private taskState: Record<string, any> = {};
  private reviewCache: Record<string, any> = {};

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.receiptsPath = path.join(rootDir, "message-receipts.jsonl");
    this.quarantinePath = path.join(rootDir, "quarantine.jsonl");
    this.taskStatePath = path.join(rootDir, "task-state.json");
    this.reviewCachePath = path.join(rootDir, "review-cache.json");
  }

  init(): void {
    ensureDir(this.rootDir);
    for (const filePath of [this.receiptsPath, this.quarantinePath]) {
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, "", "utf8");
      }
    }
    if (!fs.existsSync(this.taskStatePath)) {
      writeJson(this.taskStatePath, {});
    }
    if (!fs.existsSync(this.reviewCachePath)) {
      writeJson(this.reviewCachePath, {});
    }
    const receiptLines = fs.readFileSync(this.receiptsPath, "utf8").trim().split("\n").filter(Boolean);
    for (const line of receiptLines) {
      const row = JSON.parse(line);
      this.receipts.add(this.receiptKey(row.task_id, row.agent_id, row.msg_id));
    }
    this.taskState = readJson(this.taskStatePath);
    this.reviewCache = readJson(this.reviewCachePath);
  }

  private receiptKey(taskId: string, agentId: string, msgId: string): string {
    return `${taskId}|${agentId}|${msgId}`;
  }

  insertReceipt(taskId: string, agentId: string, msgId: string, type: string): boolean {
    const key = this.receiptKey(taskId, agentId, msgId);
    if (this.receipts.has(key)) {
      return false;
    }
    this.receipts.add(key);
    appendJsonl(this.receiptsPath, {
      task_id: taskId,
      agent_id: agentId,
      msg_id: msgId,
      message_type: type,
      processed_at: nowIso()
    });
    return true;
  }

  receiptCount(): number {
    return this.receipts.size;
  }

  appendQuarantine(row: any): void {
    appendJsonl(this.quarantinePath, {
      ...row,
      quarantined_at: nowIso()
    });
  }

  readQuarantineRows(): any[] {
    const lines = fs.readFileSync(this.quarantinePath, "utf8").trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  recordReview(taskId: string, reviewerId: string, payload: any, msgId: string): void {
    if (!this.reviewCache[taskId]) {
      this.reviewCache[taskId] = {};
    }
    const reviewerFailureCodes = Array.isArray(payload?.blocking)
      ? payload.blocking
          .map((finding: any) => String(finding?.code ?? ""))
          .filter((code: string) => /^REVIEWER_.*_ERROR$/.test(code))
      : [];
    const hasExecutionError = reviewerFailureCodes.length > 0;
    this.reviewCache[taskId][reviewerId] = {
      msg_id: msgId,
      verdict: payload.verdict,
      blocking_count: Array.isArray(payload.blocking) ? payload.blocking.length : Number(payload.blocking_count ?? 0),
      next_action: payload.next_action,
      has_execution_error: hasExecutionError,
      reviewer_failure_codes: reviewerFailureCodes
    };
    writeJson(this.reviewCachePath, this.reviewCache);
  }

  getReviews(taskId: string): Record<string, any> {
    return this.reviewCache[taskId] ?? {};
  }

  getReviewerFailureCounts(taskId: string): {
    auth_error: number;
    network_error: number;
    execution_error: number;
    total: number;
  } {
    const rows = Object.values(this.getReviews(taskId) ?? {});
    const counts = {
      auth_error: 0,
      network_error: 0,
      execution_error: 0,
      total: 0
    };
    for (const row of rows) {
      const codes = Array.isArray((row as any)?.reviewer_failure_codes) ? (row as any).reviewer_failure_codes : [];
      for (const code of codes) {
        if (code === "REVIEWER_AUTH_ERROR") {
          counts.auth_error += 1;
          counts.total += 1;
          continue;
        }
        if (code === "REVIEWER_NETWORK_ERROR") {
          counts.network_error += 1;
          counts.total += 1;
          continue;
        }
        if (code === "REVIEWER_EXECUTION_ERROR") {
          counts.execution_error += 1;
          counts.total += 1;
        }
      }
    }
    return counts;
  }

  canPublishAggregation(taskId: string): boolean {
    const row = this.taskState[taskId] ?? {};
    return !row.aggregation_published_msg_id;
  }

  markAggregationPublished(taskId: string, msgId: string): void {
    const row = this.taskState[taskId] ?? {};
    row.aggregation_published_msg_id = msgId;
    row.updated_at = nowIso();
    this.taskState[taskId] = row;
    writeJson(this.taskStatePath, this.taskState);
  }

  setFinalDecision(taskId: string, decision: any): void {
    const row = this.taskState[taskId] ?? {};
    row.final_decision = decision;
    row.updated_at = nowIso();
    this.taskState[taskId] = row;
    writeJson(this.taskStatePath, this.taskState);
  }

  getFinalDecision(taskId: string): any | null {
    return this.taskState?.[taskId]?.final_decision ?? null;
  }
}

export class PocRuntime {
  readonly mailbox: FileMailbox;
  readonly state: FileStateStore;
  readonly stateRoot: string;
  readonly requiredAgents: string[];
  readonly validationOptions: { requireTaskIdMatch: boolean; taskIdMatchTypes: string[] };
  readonly reviewerMode: "deterministic" | "cli";
  readonly cliTimeoutMs: number;
  readonly repoRoot: string;
  readonly promptByReviewer: Record<"codex" | "claude", string>;
  readonly rawOutputDir: string;
  readonly cliHomeDir: string;
  readonly artifactDir: string;
  readonly reviewSchemaPath: string;
  readonly codexOutputSchemaPath: string;
  readonly reviewSchemaJson: string;
  readonly reviewerModelById: Record<"codex" | "claude", string | undefined>;
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
    this.requiredAgents = options?.requiredAgents ?? [...REVIEWERS];
    this.validationOptions = {
      requireTaskIdMatch: options?.requireTaskIdMatch ?? true,
      taskIdMatchTypes: options?.taskIdMatchTypes ?? ["review_result", "aggregation_result"]
    };
    this.reviewerMode = options?.reviewerMode ?? "deterministic";
    this.cliTimeoutMs = options?.cliTimeoutMs ?? 120000;
    this.repoRoot = repoRoot;
    this.reviewSchemaPath = path.resolve(repoRoot, "schemas/poc/review-result.v1.schema.json");
    this.codexOutputSchemaPath = path.resolve(repoRoot, "schemas/poc/review-result.v1.codex-output.schema.json");
    this.reviewSchemaJson = JSON.stringify(readJson(this.reviewSchemaPath));
    this.reviewerModelById = {
      codex: options?.codexModel?.trim() ? options.codexModel.trim() : undefined,
      claude: options?.claudeModel?.trim() ? options.claudeModel.trim() : undefined
    };
    this.reviewInputMaxChars = Math.max(20000, Number(options?.reviewInputMaxChars ?? 120000));
    this.reviewInputExcerptChars = Math.max(4000, Number(options?.reviewInputExcerptChars ?? 24000));
    this.reviewInputIncludeDiff = options?.reviewInputIncludeDiff ?? false;
    this.cliHomeMode = options?.cliHomeMode ?? "isolated";
    this.promptByReviewer = {
      codex: fs.readFileSync(path.resolve(repoRoot, "prompts/reviewer/codex.md"), "utf8"),
      claude: fs.readFileSync(path.resolve(repoRoot, "prompts/reviewer/claude.md"), "utf8")
    };
    this.rawOutputDir = path.join(stateRoot, "raw-cli-output");
    this.cliHomeDir = path.join(stateRoot, "cli-home");
    this.artifactDir = path.join(stateRoot, "artifacts");
  }

  init(): void {
    this.mailbox.init(["codex", "claude", "aggregator", "orchestrator"]);
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
    for (const reviewerId of REVIEWERS) {
      const assignmentPayload = {
        review_request_ref: `artifact://${taskId}/review-request.md`,
        review_input_ref: reviewInput.reviewInputRef,
        review_input_source: reviewInput.reviewInputSource,
        review_input_excerpt: reviewInput.reviewInputExcerpt,
        reviewer_model_hint: this.reviewerModelById[reviewerId],
        required_agents: [...this.requiredAgents],
        instruction
      };
      const envelope = this.createEnvelope({
        taskId,
        senderId: "orchestrator",
        to: reviewerId,
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

  private writeRawCliOutput(taskId: string, reviewerId: "codex" | "claude", text: string): string {
    const filePath = path.join(this.rawOutputDir, `${taskId}--${reviewerId}--${Date.now()}.txt`);
    fs.writeFileSync(filePath, text, "utf8");
    return filePath;
  }

  private buildReviewerPrompt(reviewerId: "codex" | "claude", assignmentEnvelope: any): string {
    const basePrompt = this.promptByReviewer[reviewerId];
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

  private buildCliEnv(): NodeJS.ProcessEnv {
    if (this.cliHomeMode === "host") {
      return { ...process.env };
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
      HOME: this.cliHomeDir,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      XDG_DATA_HOME: xdgData
    };
  }

  private executeReviewerCli(
    reviewerId: "codex" | "claude",
    assignmentEnvelope: any
  ): { payload: any; rawOutputRef: string } {
    const prompt = this.buildReviewerPrompt(reviewerId, assignmentEnvelope);
    const env = this.buildCliEnv();
    let cmd = "";
    let args: string[] = [];

    if (reviewerId === "codex") {
      cmd = "codex";
      args = [
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
      if (this.reviewerModelById.codex) {
        args.splice(1, 0, "--model", this.reviewerModelById.codex);
      }
    } else {
      cmd = "claude";
      args = ["-p", prompt, "--output-format", "json", "--json-schema", this.reviewSchemaJson];
      if (this.reviewerModelById.claude) {
        args.push("--model", this.reviewerModelById.claude);
      }
    }

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
    const rawOutputRef = this.writeRawCliOutput(assignmentEnvelope.task_id, reviewerId, rawText);

    if (run.error) {
      const message = `${reviewerId} execution error: ${String(run.error.message ?? run.error)} (raw=${rawOutputRef})`;
      throw new ReviewerCliError(classifyReviewerFailure(message), message, rawOutputRef);
    }
    if (typeof run.status === "number" && run.status !== 0) {
      const message = `${reviewerId} exited with status=${run.status}\nstdout=${String(run.stdout ?? "")}\nstderr=${String(
        run.stderr ?? ""
      )}\nraw=${rawOutputRef}`;
      throw new ReviewerCliError(classifyReviewerFailure(message), message, rawOutputRef);
    }

    let parsed = parseJsonLenient(String(run.stdout ?? ""));
    if (reviewerId === "claude" && parsed && typeof parsed === "object") {
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
    reviewerId: "codex" | "claude",
    taskId: string,
    payload: any,
    rawOutputRef: string
  ): any {
    const defaultModel =
      this.reviewerModelById[reviewerId] ?? (reviewerId === "codex" ? "gpt-5-codex" : "claude-sonnet");
    const verdict = payload?.verdict === "FAIL" ? "FAIL" : "PASS";
    const blocking = toFindingArray(payload?.blocking);
    const nonBlocking = toFindingArray(payload?.non_blocking);
    const confidence = ["high", "medium", "low"].includes(payload?.confidence) ? payload.confidence : "medium";
    const nextAction =
      ["proceed", "rework", "manual_review_required"].includes(payload?.next_action)
        ? payload.next_action
        : verdict === "FAIL"
        ? "rework"
        : "proceed";

    return {
      schema_version: 1,
      task_id: taskId,
      model: String(payload?.model ?? defaultModel),
      verdict,
      blocking,
      non_blocking: nonBlocking,
      summary: String(payload?.summary ?? `${reviewerId} review ${verdict.toLowerCase()}`),
      confidence,
      next_action: nextAction,
      generated_at: typeof payload?.generated_at === "string" ? payload.generated_at : nowIso(),
      raw_output_ref: String(payload?.raw_output_ref ?? rawOutputRef)
    };
  }

  processReviewer(reviewerId: "codex" | "claude"): number {
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
          const cli = this.executeReviewerCli(reviewerId, item.envelope);
          reviewPayload = this.normalizeReviewPayload(reviewerId, item.envelope.task_id, cli.payload, cli.rawOutputRef);
        } catch (error) {
          const errCode =
            error instanceof ReviewerCliError ? error.code : "REVIEWER_EXECUTION_ERROR";
          const rawOutputRef =
            error instanceof ReviewerCliError
              ? error.rawOutputRef
              : `artifact://${item.envelope.task_id}/${reviewerId}/execution-error/${Date.now()}`;
          reviewPayload = {
            schema_version: 1,
            task_id: item.envelope.task_id,
            model:
              this.reviewerModelById[reviewerId] ?? (reviewerId === "codex" ? "gpt-5-codex" : "claude-sonnet"),
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
            summary: `${reviewerId} CLI execution failed`,
            confidence: "medium",
            next_action: "manual_review_required",
            generated_at: nowIso(),
            raw_output_ref: rawOutputRef
          };
        }
      } else {
        const instruction = String(item.envelope?.payload?.instruction ?? "");
        const forceFail = instruction.includes(`force-fail:${reviewerId}`);
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
          model:
            this.reviewerModelById[reviewerId] ?? (reviewerId === "codex" ? "gpt-5-codex" : "claude-sonnet"),
          verdict: forceFail ? "FAIL" : "PASS",
          blocking,
          non_blocking: [],
          summary: forceFail ? `${reviewerId} found blocking issue` : `${reviewerId} review passed`,
          confidence: "high",
          next_action: forceFail ? "rework" : "proceed",
          generated_at: nowIso(),
          raw_output_ref: `artifact://${item.envelope.task_id}/${reviewerId}/${Date.now()}`
        };
      }

      const reviewEnvelope = this.createEnvelope({
        taskId: item.envelope.task_id,
        senderId: reviewerId,
        to: "aggregator",
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
    const messages = this.mailbox.consume("aggregator", 100);
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
        senderId: "aggregator",
        to: "orchestrator",
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
    const messages = this.mailbox.consume("orchestrator", 100);
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
    actions += this.processReviewer("codex");
    actions += this.processReviewer("claude");
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
    const payload = {
      schema_version: 1,
      task_id: payloadTaskId,
      model: "gpt-5-codex",
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
      senderId: "codex",
      to: "aggregator",
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
}
