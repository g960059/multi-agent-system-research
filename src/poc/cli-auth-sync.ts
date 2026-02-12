// @ts-nocheck
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copySecret(srcPath: string, dstPath: string): { status: string; bytes?: number } {
  if (!fs.existsSync(srcPath)) {
    return { status: "missing_source" };
  }
  ensureDir(path.dirname(dstPath));
  fs.copyFileSync(srcPath, dstPath);
  try {
    fs.chmodSync(dstPath, 0o600);
  } catch {
    // ignore chmod error on unsupported fs.
  }
  const bytes = fs.statSync(dstPath).size;
  return { status: "copied", bytes };
}

function main() {
  const stateRoot = path.resolve("tmp/poc-mailbox/state");
  const cliHome = path.resolve(stateRoot, "cli-home");
  const sourceHome = path.resolve(process.env.POC_AUTH_SOURCE_HOME ?? os.homedir());

  ensureDir(cliHome);
  ensureDir(path.join(cliHome, ".config"));
  ensureDir(path.join(cliHome, ".cache"));
  ensureDir(path.join(cliHome, ".state"));
  ensureDir(path.join(cliHome, ".local", "share"));
  ensureDir(path.join(cliHome, ".codex"));
  ensureDir(path.join(cliHome, ".claude"));

  const plan = [
    {
      name: "codex_auth_json",
      src: path.join(sourceHome, ".codex", "auth.json"),
      dst: path.join(cliHome, ".codex", "auth.json")
    },
    {
      name: "codex_config_toml",
      src: path.join(sourceHome, ".codex", "config.toml"),
      dst: path.join(cliHome, ".codex", "config.toml")
    },
    {
      name: "claude_root_json",
      src: path.join(sourceHome, ".claude.json"),
      dst: path.join(cliHome, ".claude.json")
    }
  ];

  const copied = plan.map((item) => ({
    name: item.name,
    src: item.src,
    dst: item.dst,
    ...copySecret(item.src, item.dst)
  }));

  const result = {
    cli_home_dir: cliHome,
    source_home: sourceHome,
    copied,
    next_steps: [
      "npm run poc:cli:check",
      "POC_CLI_HOME_MODE=host npm run poc:cli:check",
      `HOME=${cliHome} codex login status`,
      `HOME=${cliHome} claude -p \"auth-check\" --output-format json`,
      `If claude remains auth_error, run: HOME=${cliHome} claude (then /login), or set CLAUDE_CODE_OAUTH_TOKEN in env`
    ]
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
