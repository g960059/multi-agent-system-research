# Codebase Map (Mailbox PoC)

最終更新: 2026-02-16  
対象: `multi-agent-system-research`

## 1. 目的

この文書は、repo全体と `mailbox-parallel-review` skill の構造を短時間で把握するための地図。

## 2. ルート構成 (責務別)

```text
.
├── src/poc/                          # 実装本体 (TypeScript)
│   ├── runtime-main.ts               # CLI entrypoint
│   ├── runtime.ts                    # mailbox orchestration core
│   ├── cli-preflight.ts              # codex/claude preflight
│   ├── cli-auth-sync.ts              # isolated HOME auth sync
│   ├── e2e.ts                        # e2e regression
│   └── modules/
│       ├── agent-definition-policy.ts
│       ├── agent-adapter.ts
│       ├── envelope-policy.ts
│       ├── file-mailbox.ts
│       └── file-state-store.ts
├── schemas/poc/                      # JSON schema contracts
├── prompts/reviewer/                 # reviewer prompt templates
├── agents/
│   ├── agents.example.yaml           # agent definition sample
│   └── skills/mailbox-parallel-review/
│       ├── SKILL.md                  # repo-local skill guide
│       └── scripts/
│           ├── run_parallel_review.mjs
│           └── run_parallel_review.test.mjs
├── scripts/mailbox/                  # portable npm wrappers
│   ├── run_parallel_review.mjs
│   └── run_parallel_review.test.mjs  # symlink to skill test
├── package.json                      # npm entrypoints
├── docs/                             # design/mapping docs
├── plan/                             # roadmap/runbook/examples
├── dist/                             # build artifacts
└── tmp/poc-mailbox/                  # runtime state/mailbox artifacts
```

## 3. 読み始め順 (最短導線)

1. `package.json`  
   実行導線 (`mailbox:review*`, `poc:*`) を把握。
2. `src/poc/runtime-main.ts`  
   引数解決 -> runtime起動 -> JSON出力の入口。
3. `src/poc/runtime.ts`  
   fan-out, reviewer実行, aggregation, final decision の本体。
4. `src/poc/modules/agent-definition-policy.ts`  
   `provider x role` から `command_template`/`allowed_message_types`/`env_profile` を自動補完。
5. `src/poc/modules/agent-adapter.ts`  
   runtime向け reviewer profile と ACL を構築。
6. `agents/skills/mailbox-parallel-review/SKILL.md`  
   skill使用時の運用手順と失敗トリアージ。

## 4. 実行アーキテクチャ (要点)

1. `runtime-main.ts` が config (`--agents-config-json` / `--agent-profiles-json`) を読み込む。
2. `agent-definition-policy.ts` が role/providerポリシーで不足項目を補完する。
3. `runtime.ts` が mailbox に `task_assignment` を fan-out し、reviewer結果を `aggregation_result` に集約。
4. `file-mailbox.ts` と `file-state-store.ts` が `tmp/poc-mailbox/` に状態を保存。
5. 最後に `runtime-main.ts` が `operational_gate` / `reviewer_failure_counts` / `final_decision` を JSON で出力。

## 5. Skill 構造

### 5.1 Repo-local skill

1. `agents/skills/mailbox-parallel-review/SKILL.md`  
   このrepo向け手順。`npm run mailbox:review*` を主入口として案内。
2. `agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs`  
   preflight -> runtime -> JSON summary 化。
3. `agents/skills/mailbox-parallel-review/scripts/run_parallel_review.test.mjs`  
   parser/args/integration/timeout系テスト。

### 5.2 Portable wrapper (repo側)

1. `scripts/mailbox/run_parallel_review.mjs`  
   実体スクリプトを検索して委譲するラッパー。探索順は以下。  
   - `agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs`  
   - `~/.agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs`
2. `scripts/mailbox/run_parallel_review.test.mjs`  
   repo-local skill testへのsymlink。

### 5.3 npm entrypoints

1. `npm run mailbox:review`
2. `npm run mailbox:review:cli`
3. `npm run mailbox:review:deterministic`
4. `npm run mailbox:review:test`

## 6. 設定/契約の正本

1. `schemas/poc/agent-definition.v1.schema.json`
2. `schemas/poc/mailbox-envelope.v1.schema.json`
3. `schemas/poc/review-result.v1.schema.json`
4. `schemas/poc/aggregation-result.v1.schema.json`
5. `agents/agents.example.yaml`
6. `plan/mailbox-poc-agent-definitions.example.json`
7. `plan/mailbox-poc-agent-profiles.example.json`

## 7. テスト入口

1. `npm run poc:e2e`
2. `npm run mailbox:review:test`
3. `npm run skill:test:mailbox-parallel-review`
4. `src/poc/e2e.ts` (直接読む場合)

## 8. 実行時データ

1. `tmp/poc-mailbox/mailbox/`  
   `inbox/`, `ack/`, `deadletter/` を保持。
2. `tmp/poc-mailbox/state/`  
   `message-receipts.jsonl`, `review-cache.json`, `task-state.json`, `quarantine.jsonl` など。
3. `tmp/poc-mailbox/state/artifacts/`  
   review input / raw CLI output の参照アーティファクト。

## 9. 変更時の判断ガイド

1. role/providerの自動補完ルールを変える -> `src/poc/modules/agent-definition-policy.ts`
2. runtimeで使うagent構造/ACLを変える -> `src/poc/modules/agent-adapter.ts`
3. mailbox処理順・retry・集約ロジックを変える -> `src/poc/runtime.ts`
4. skillの運用導線を変える -> `agents/skills/mailbox-parallel-review/SKILL.md` と `scripts/mailbox/run_parallel_review.mjs`

## 10. 詳細参照

1. module依存関係とinterfaceの詳細は `docs/module-dependency-interface-map.ja.md` を参照。
2. workflow/task 抽象化の再設計案は `docs/workflow-task-abstraction.ja.md` を参照。
