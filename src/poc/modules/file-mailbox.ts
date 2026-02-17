// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

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

export type ConsumedMessage = {
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
