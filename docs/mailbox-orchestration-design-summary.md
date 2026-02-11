# Multi-Agent Orchestration Design Summary (Mailbox-based)

## Scope
This document summarizes the design decisions discussed for a multi-agent system where coder/reviewer and larger teams collaborate via a mailbox model.

## Policy Update (2026-02-11)
- Build the workflow runtime in-house (TAKT is a design reference, not a runtime dependency).
- Standardize implementation language on TypeScript (Node.js).
- Treat hooks as optional adapters; keep core orchestration in external runtime components.

Related docs:
- `plan/00-module-boundary-and-interface-contract.ja.md`
- `plan/multi-agent-platform-plan.ja.md`

## 1. Core Direction
- Use `tmux` for process survivability (long-running workers, reattach, respawn).
- Use `~/.mailbox` (or repo-local mailbox) as the communication channel.
- Do **not** use `tmux send-keys/capture-pane` as a primary protocol.
- Keep orchestrator **non-LLM** for deterministic control.

## 2. Why Mailbox over Tmux-as-Transport
- Tmux direct I/O is prompt-state dependent and brittle.
- Parsing terminal output is unstable due to ANSI, timing, and mode differences.
- Mailbox files enable reliable replay, audit, idempotency, and retries.

## 3. Enforcement Strategy (How to make agents follow mailbox)
`AGENTS.md` and skills are guidance only. Hard enforcement should be external.

Recommended layering:
1. External orchestrator/worker scripts (hard enforcement)
2. Runtime restrictions (writable paths, network restrictions)
3. Message schema validation + state machine checks
4. AGENTS.md / skill instructions (soft guidance)

## 4. Context Growth and Compaction Handling
### Practical baseline
- If no compaction and task boundaries are clear, reading only unread inbox messages can work.

### Safety additions (recommended)
- Add metadata to every message:
  - `task_id`, `msg_id`, `parent_id`, `state_version`, `summary_hash`
- Agent tracks `last_seen_msg_id`.
- If sequence gaps or hash mismatch are detected, return `resync-required`.
- Keep a task state capsule (`state/<task_id>.md`) as canonical context.

This gives:
- Fast path: unread-only processing
- Safe path: explicit resync when drift is detected

## 5. Team Communication and Broadcast Control
### Main rule
- Default to unicast.
- Broadcast must go through orchestrator fan-out only.

### Why
- Prevent exponential message storms (N agents replying to all agents repeatedly).

### Guardrails
- Restrict broadcast message types (e.g., `announce`, `vote-request`).
- Disallow auto-reply-to-broadcast.
- Use `round_id` and `max_replies_per_round=1`.
- Prefer gather-and-reduce pattern:
  - each agent replies once to orchestrator
  - orchestrator sends one aggregated update back

## 6. Dynamic Team Lifecycle (Summon/Disband)
Dynamic teams are needed for large workflows, but control can remain deterministic.

### Two-layer model
1. **Control layer (non-LLM orchestrator)**
   - Executes workflow/state transitions from `workflow.yaml`.
   - Decides spawn/drain based on structured status fields only.
2. **Reasoning layer (LLM agents)**
   - Produces task outputs/reviews.
   - Returns structured decisions (`PASS/FAIL`, `blocking`, `next_stage`).

### Team operations
- Summon: create `team/<team_id>.json` and spawn workers by role/count.
- Disband (graceful): stop new assignments, drain running jobs, terminate workers.
- Disband (force): stop workers immediately, requeue leased jobs.

## 7. Polling / Heartbeat / Recovery
Start with simple polling; optimize later only if needed.

### Recommended intervals
- Worker inbox poll: every `1-2s`.
- Exponential backoff when idle: `1s -> 2s -> 4s` (cap `5s`).
- Worker heartbeat update: every `10s`.
- Orchestrator health scan: every `30s`.
- Heartbeat TTL: `30-45s`.

### Lease model
- On claim: set `lease_until` (e.g., now + 60s).
- Worker renews lease periodically (e.g., every 20s).
- If lease expires, orchestrator requeues.

### Failure handling
- State transitions: `queued -> running -> done|failed|deadletter`.
- Retry with max attempts.
- Dead-letter queue for repeated failures.
- Respawn worker in tmux on crash.

## 8. Quality Gate Loop (Coder <-> Reviewer)
- Reviewer returns `PASS` or `FAIL` with `blocking/non-blocking` findings.
- If `FAIL(blocking)`, automatically route back to coder.
- Continue until gate passes or `max_iterations` is reached.
- Gate checks can include tests/lint/security/secret scan.

## 9. Recommended System Split
Implement as 4 cooperating subsystems:
1. `workflow` system (stage transitions)
2. `mailbox` system (message transport)
3. `task` system (state, retries, leases, DLQ)
4. `runtime` system (polling, heartbeat, worker supervision)

## 10. Suggested Minimal Rollout
1. Single coder + single reviewer with mailbox and basic gate loop.
2. Add heartbeat + lease + retry + dead-letter.
3. Add team fan-out and dynamic spawn/drain.
4. Add optimization (event-driven notifications, fswatch/inotify) only when polling cost matters.

## 11. Notes about Hooks
- Hooks are useful as helpers, but not sufficient as core enforcement.
- In Codex CLI, `notify` integration is available and useful for human notifications.
- Core orchestration reliability should still live in external scripts/services.

## 12. Key Takeaway
- Communication: mailbox
- Survivability: tmux
- Deterministic control: non-LLM orchestrator
- Intelligence: LLM workers

This separation provides both reliability and flexibility for iterative quality-gated multi-agent workflows.
