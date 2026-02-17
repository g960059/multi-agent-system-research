# Module Dependency & Interface Map (Mailbox PoC)

最終更新: 2026-02-16  
対象: `multi-agent-system-research`

## 1. 目的

`src/poc` と `mailbox-parallel-review` skill の依存関係、責務境界、公開interfaceを変更影響ベースで把握するための詳細マップ。

## 2. 全体依存グラフ

```text
package.json (scripts)
  ├─ mailbox:review* -> scripts/mailbox/run_parallel_review.mjs
  │                      └─ resolve runner:
  │                         1) agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs
  │                         2) ~/.agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs
  │
  ├─ poc:cli:check    -> dist/poc/cli-preflight.js
  ├─ poc:runtime*     -> dist/poc/runtime-main.js
  └─ poc:e2e          -> dist/poc/e2e.js

src/poc/runtime-main.ts
  ├─ modules/agent-definition-policy.ts
  │   └─ modules/agent-adapter.ts
  └─ runtime.ts
      ├─ modules/agent-adapter.ts
      ├─ modules/envelope-policy.ts
      ├─ modules/file-mailbox.ts
      └─ modules/file-state-store.ts
```

## 3. レイヤー構造

### 3.1 Entry Layer

1. `scripts/mailbox/run_parallel_review.mjs`  
   repo/local環境差を吸収して実体runnerへ委譲。
2. `agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs`  
   preflight + runtime実行 + summary JSON化。
3. `src/poc/runtime-main.ts`  
   runtimeのCLI entrypoint。

### 3.2 Domain Orchestration Layer

1. `src/poc/runtime.ts` (`PocRuntime`)  
   assignment fan-out、review受信、aggregation、final decision保存。

### 3.3 Policy / Adapter Layer

1. `src/poc/modules/agent-definition-policy.ts`  
   `provider x role` からポリシー自動補完。
2. `src/poc/modules/agent-adapter.ts`  
   runtime向け config正規化 + ACL生成。
3. `src/poc/modules/envelope-policy.ts`  
   envelope署名/検証。

### 3.4 Infrastructure Layer

1. `src/poc/modules/file-mailbox.ts`  
   inbox/ack/deadletter をファイルで実装。
2. `src/poc/modules/file-state-store.ts`  
   receipt / quarantine / review-cache / task-state を保存。

## 4. 主要interface一覧

| Module | 公開interface | 入力 | 出力 | 主責務 |
|---|---|---|---|---|
| `src/poc/modules/agent-adapter.ts` | `ReviewerAgentProfile`, `RuntimeAgentConfig`, `buildRuntimeAgentConfig()`, `buildAcl()` | reviewer profile配列, model override | 正規化済runtime config, ACL | runtimeに渡す最小実行構造を組み立てる |
| `src/poc/modules/agent-definition-policy.ts` | `AgentRole`, `applyAgentDefinitionPolicy()`, `buildRuntimeAgentConfigFromDefinitions()` | agent-definition document | 補完済document + runtime config | role/providerから default command/env/message types を補完 |
| `src/poc/modules/envelope-policy.ts` | `signatureForEnvelope()`, `validateEnvelope()` | envelope, validation options | `ok` + `code/message` | 改ざん/route/ACL/task_id不整合を検知 |
| `src/poc/modules/file-mailbox.ts` | `ConsumedMessage`, `FileMailbox` | envelope publish/consume操作 | inbox->ack/deadletterの状態遷移 | pull型メールボックスI/O |
| `src/poc/modules/file-state-store.ts` | `FileStateStore` | receipt, review, decision記録 | dedup状態, failure集計, final decision | durable-ish state管理 |
| `src/poc/runtime.ts` | `validateEnvelope()`, `PocRuntime` | runtime options, mailbox events | aggregation/final decision | mailbox orchestration core |
| `src/poc/runtime-main.ts` | (CLI entry only) | CLI args + optional JSON config | runtime summary JSON | execution bootstrap |

## 5. `PocRuntime` の公開面

実行制御:

1. `init()`
2. `seedTask(taskId, instruction)`
3. `runOnePass()`
4. `runUntilStable(maxPasses)`

状態参照:

1. `getFinalDecision(taskId)`
2. `getReviewerFailureCounts(taskId)`
3. `getQuarantineRows()`
4. `getReceiptCount()`
5. `getReviewerProfiles()`
6. `getOrchestratorId()`
7. `getAggregatorId()`
8. `getDeadletterCounts()`

テスト注入補助:

1. `duplicateFirstInboxMessage(agentId)`
2. `injectTaskIdMismatchReview(taskId, payloadTaskId)`

## 6. Policy/Adapter境界

### 6.1 `agent-definition-policy`

補完対象:

1. `allowed_message_types` (role由来)
2. `command_template` (provider/role由来)
3. `env_profile` + `env` (provider + env_profiles由来)

制約:

1. reviewer-capable role (`review_result` を扱う role) で `provider=local` は拒否。
2. `env_profile` 参照先が未定義なら拒否。

### 6.2 `agent-adapter`

保証:

1. reviewer id の重複を禁止。
2. reviewer id と orchestrator/aggregator id の衝突を禁止。
3. `provider` は `codex|claude` のみ許容。

## 7. メッセージ契約と実装の対応

1. `schemas/poc/agent-definition.v1.schema.json`  
   `runtime-main.ts` -> `agent-definition-policy.ts` で消費。
2. `schemas/poc/mailbox-envelope.v1.schema.json`  
   `runtime.ts#createEnvelope()` で生成、`envelope-policy.ts` で検証。
3. `schemas/poc/review-result.v1.schema.json`  
   `runtime.ts#normalizeReviewPayload()` で正規化。
4. `schemas/poc/aggregation-result.v1.schema.json`  
   `runtime.ts#processAggregator()` で生成。

## 8. 実行シーケンス (要約)

### 8.1 CLI mode

1. `mailbox:review:cli` -> wrapper -> skill runner
2. skill runner が `poc:cli:check` を実行
3. preflight成功後に `poc:runtime:cli` を実行
4. runtime summary を抽出し、skill summary JSONとして返す

### 8.2 deterministic mode

1. `mailbox:review:deterministic` -> wrapper -> skill runner
2. preflightは省略可
3. `poc:runtime` 実行
4. 決定論的review payloadで集約し summary JSONを返す

## 9. 変更影響マトリクス

| 変更したい内容 | 主編集先 | 影響先 |
|---|---|---|
| role/providerごとのデフォルトポリシー | `src/poc/modules/agent-definition-policy.ts` | `runtime-main.ts`, `runtime.ts`, config examples |
| reviewerプロファイルの正規化/ACL | `src/poc/modules/agent-adapter.ts` | `runtime.ts` の validation/dispatch |
| envelope検証ルール | `src/poc/modules/envelope-policy.ts` | `runtime.ts`, `e2e.ts` |
| mailbox状態遷移 | `src/poc/modules/file-mailbox.ts` | `runtime.ts`, `e2e.ts` |
| dedup/failure集計/final decision保存 | `src/poc/modules/file-state-store.ts` | `runtime.ts`, `runtime-main.ts` |
| skillのCLI UX/要約JSON | `agents/skills/mailbox-parallel-review/scripts/run_parallel_review.mjs` | `SKILL.md`, handover artifacts |
| repo portability入口 | `scripts/mailbox/run_parallel_review.mjs`, `package.json` | 全skill利用導線 |

## 10. 現在の注意点

1. `scripts/mailbox/run_parallel_review.mjs` は repo-local skill runner を優先する。`~/.agents` 側の更新があっても、repo-localが先に使われる。
2. `runOnePass()` は reviewerを順次処理する実装で、プロセス同時実行モデルではない。
3. state/mailboxはファイル実装のため、PoC外用途では durability/lock/recovery強化が必要。

