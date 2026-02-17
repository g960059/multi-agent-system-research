---
name: mailbox-parallel-review
description: Run Codex and Claude in parallel via the mailbox-first PoC runtime, including CLI preflight, runtime execution, and operational gate triage. Use when asked to execute or investigate parallel review runs in this repository.
---

# Mailbox Parallel Review

Use this skill when you need a Codex/Claude parallel review run on the mailbox runtime.
For reproducible reruns, always pass an explicit `--task-id`.

## What This Skill Runs

- Preflight check: `npm run poc:cli:check`
- Parallel runtime:
  - CLI mode: `npm run poc:runtime:cli`
  - Deterministic mode: `npm run poc:runtime`
- Result extraction:
  - `operational_gate`
  - `reviewer_failure_counts`
  - `final_decision`

## Preferred Entry Point

Use npm scripts (portable entry point for this repository):

```bash
npm run mailbox:review:cli -- --task-id task-skill-cli-host --instruction "normal review"
```

## Common Commands

CLI mode (host auth):

```bash
npm run mailbox:review:cli -- \
  --task-id task-skill-cli-host \
  --instruction "normal review"
```

CLI mode (isolated auth check):

```bash
npm run mailbox:review -- \
  --reviewer-mode cli \
  --cli-home-mode isolated \
  --task-id task-skill-cli-isolated \
  --instruction "normal review"
```

Deterministic smoke:

```bash
npm run mailbox:review:deterministic -- \
  --task-id task-skill-deterministic \
  --instruction "normal review"
```

Adapter profile test (custom reviewer roles):

```bash
npm run mailbox:review:deterministic -- \
  --task-id task-custom-reviewer-profiles \
  --instruction "normal review" \
  --agent-profiles-json plan/mailbox-poc-agent-profiles.example.json
```

Agent-definition policy test (provider/role auto policy):

```bash
npm run mailbox:review:deterministic -- \
  --task-id task-agent-definitions \
  --instruction "normal review" \
  --agents-config-json plan/mailbox-poc-agent-definitions.example.json
```

Mailbox integration test for this skill:

```bash
npm run mailbox:review:test
```

## Interpretation Rules

- `operational_gate=healthy`: runtime and reviewer execution are healthy.
- `operational_gate=block_and_fix_auth`: fix CLI auth first.
- `operational_gate=manual_review_network_retry`: retry after network stabilization.
- `operational_gate=manual_review_execution_retry`: inspect raw CLI output and rerun.

## Script Failure Triage

- Exit code `2` with `aborted=preflight_failed`:
  - fix auth/network first, or rerun with `--allow-preflight-failure` only for investigation.
- Exit code `2` with `Failed to parse preflight JSON output`:
  - inspect `npm run poc:cli:check` output; retry with larger `--max-buffer-mb`.
- Exit code `1` with runtime parse failure:
  - inspect runtime stdout/stderr directly and rerun.

## Notes

- Default mode in this skill script is `reviewer-mode=cli` and `cli-home-mode=host`.
- If you must validate isolated auth state, set `--cli-home-mode isolated`.
- Add `--output-json <path>` to persist the full runtime JSON for handover artifacts.
- Use `--max-buffer-mb <n>` when running with very large diff/context.
