// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";

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
