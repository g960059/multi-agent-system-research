// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function classify(text: string): string {
  const s = String(text ?? "");
  if (/401 Unauthorized|Invalid API key|Missing bearer|Please run \/login|authentication/i.test(s)) {
    return "auth_error";
  }
  if (/network error|stream disconnected|timed out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(s)) {
    return "network_error";
  }
  return "execution_error";
}

function runCheck(opts: {
  name: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: any;
  timeoutMs: number;
}) {
  const run = cp.spawnSync(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  const stdout = String(run.stdout ?? "");
  const stderr = String(run.stderr ?? "");
  const merged = `${stdout}\n${stderr}`;
  const ok = !run.error && run.status === 0;
  return {
    name: opts.name,
    command: `${opts.cmd} ${opts.args.map((x) => JSON.stringify(x)).join(" ")}`,
    ok,
    status: run.status,
    error: run.error ? String(run.error.message ?? run.error) : undefined,
    category: ok ? "ok" : classify(merged),
    stdout,
    stderr
  };
}

function main() {
  const repoRoot = process.cwd();
  const stateRoot = path.resolve("tmp/poc-mailbox/state");
  const cliHome = path.resolve(stateRoot, "cli-home");
  const cliHomeMode = String(process.env.POC_CLI_HOME_MODE ?? "isolated").trim() === "host" ? "host" : "isolated";
  const timeoutMs = Number(process.env.POC_CLI_CHECK_TIMEOUT_MS ?? "180000");
  const schemaPath = path.resolve(repoRoot, "schemas/poc/review-result.v1.schema.json");
  const codexSchemaPath = path.resolve(repoRoot, "schemas/poc/review-result.v1.codex-output.schema.json");
  const schemaJson = JSON.stringify(readJson(schemaPath));
  const codexModel = String(process.env.POC_CODEX_MODEL ?? "").trim();
  const claudeModel = String(process.env.POC_CLAUDE_MODEL ?? "").trim();
  ensureDir(cliHome);
  ensureDir(path.join(cliHome, ".config"));
  ensureDir(path.join(cliHome, ".cache"));
  ensureDir(path.join(cliHome, ".state"));
  ensureDir(path.join(cliHome, ".local", "share"));

  const env =
    cliHomeMode === "host"
      ? { ...process.env }
      : {
          ...process.env,
          HOME: cliHome,
          XDG_CONFIG_HOME: path.join(cliHome, ".config"),
          XDG_CACHE_HOME: path.join(cliHome, ".cache"),
          XDG_STATE_HOME: path.join(cliHome, ".state"),
          XDG_DATA_HOME: path.join(cliHome, ".local", "share")
        };

  const taskId = "task-cli-preflight";
  const prompt = [
    "Return only JSON matching review-result schema.",
    `Set task_id=${taskId}`,
    "Use verdict=PASS if no issue.",
    "Do not execute shell commands or any external tools."
  ].join("\n");

  const codex = runCheck({
    name: "codex",
    cmd: "codex",
    args: [
      "exec",
      ...(codexModel ? ["--model", codexModel] : []),
      "--sandbox",
      "read-only",
      "--cd",
      repoRoot,
      "--skip-git-repo-check",
      "--output-schema",
      codexSchemaPath,
      prompt
    ],
    cwd: repoRoot,
    env,
    timeoutMs
  });

  const claude = runCheck({
    name: "claude",
    cmd: "claude",
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      schemaJson,
      ...(claudeModel ? ["--model", claudeModel] : [])
    ],
    cwd: repoRoot,
    env,
    timeoutMs
  });

  const summary = {
    cli_home_dir: cliHome,
    cli_home_mode: cliHomeMode,
    timeout_ms: timeoutMs,
    codex_model: codexModel || null,
    claude_model: claudeModel || null,
    codex: {
      ok: codex.ok,
      status: codex.status,
      category: codex.category
    },
    claude: {
      ok: claude.ok,
      status: claude.status,
      category: claude.category
    },
    details: {
      codex,
      claude
    }
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
