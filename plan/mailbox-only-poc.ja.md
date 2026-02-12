# Mailbox-Only PoC 実装計画（Workflow Module なし）

作成日: 2026-02-11  
対象: `multi-agent-system-research`

## 1. 目的

`workflow module` を実装する前に、次を先に検証する。

- mailbox + control kernel だけで Codex/Claude の並列レビューが安定動作するか
- outbox relay により通知欠落なしで復旧できるか
- 共通schemaで2モデルのレビュー結果を正規化できるか

## 2. 非目標（このPoCではやらない）

- DAG実行、動的team編成、service stage
- hooks adapter 統合
- 本番向け最適化（通知駆動、高可用クラスタ）

## 3. 最小アーキテクチャ

コンポーネント:

1. `Control Kernel`
   - task state管理、claim/lease、状態遷移、event append、outbox insert を同一Txで実行
2. `Mailbox Relay`
   - outbox から inbox へ at-least-once 配送、ack/nack 管理
3. `Worker Runner (codex / claude)`
   - inbox を consume してレビューを実行、`review_result` を publish
4. `Review Aggregator`
   - Codex/Claude の結果を統合し最終判定を返す

### 3.1 Process Manager 境界（疎結合ルール）

- 詳細設計: `plan/process-manager-boundary.ja.md`
- 契約定義: `contracts/poc/process-manager-boundary.ts`

依存ルール:

1. `TaskDomain` は純粋関数として実装し、Mailbox/Spawn/DBを参照しない
2. `ProcessManager` は DomainEvent を IntegrationCommand へ変換するだけ
3. I/O は Ports/Adapters (`MailboxTransport`, `Outbox`, `ExecutionAdapter`) のみが担当

## 4. ディレクトリ構成（PoC）

```text
tmp/poc-mailbox/
  state/
    state.db
  mailbox/
    inbox/
      codex/
      claude/
      aggregator/
    outbox/
    ack/
    deadletter/
```

## 5. Spawn戦略（初期固定）

- worker 数: `codex=1`, `claude=1`, `aggregator=1`（principal名と同一）
- spawn ポリシー: `1 task = 1 process`（再現性優先）
- 実行コマンド:
  - codex: `codex exec --full-auto --sandbox read-only --cd <repo> "<prompt>"`
  - claude: `claude -p "<prompt>"`
- 将来拡張:
  - 安定後に `long_running_worker`（常駐）へ切替可能

理由:

- まずはプロセスリーク/状態残留を避けて失敗原因を切り分ける。
- CLI差異は runner 層で吸収する。

## 6. Duration/Timeout/Lease 推奨値

- `heartbeat_interval_sec = 15`
- `heartbeat_ttl_sec = 45`
- `lease_ttl_sec = 180`
- `lease_renew_interval_sec = 45`
- `task_soft_timeout_sec = 600`（10分）
- `task_hard_timeout_sec = 900`（15分）
- `max_attempts = 2`

運用ルール:

- soft timeout 到達時は worker に中断要求し、hard timeout で強制終了。
- 強制終了時は `nack + requeue`、上限超過は dead-letter。

## 7. メッセージ契約

- envelope: `schemas/poc/mailbox-envelope.v1.schema.json`
- review_result payload: `schemas/poc/review-result.v1.schema.json`
- aggregation_result payload: `schemas/poc/aggregation-result.v1.schema.json`
- agents定義: `agents/agents.example.yaml`
- agents schema: `schemas/poc/agent-definition.v1.schema.json`
- domain event: `schemas/poc/domain-event.v1.schema.json`
- process manager command: `schemas/poc/process-manager-command.v1.schema.json`

必須条件:

- 署名検証OKのみ処理
- `msg_id` で重複排除
- `task_id + state_version` で順序確認
- 欠番検知時は `resync-required`
- `from == sender_id` を必須検証し、不一致は隔離する
- ACL主体は envelope `sender_id` に固定する（payload内主体は信頼しない）
- `review_result` payload には `agent_id` を持たせない
- `review_result` / `aggregation_result` は `envelope.task_id == payload.task_id` を必須検証し、不一致は隔離する
- `message_receipts(agent_id, msg_id)` を一意制約で永続化する（`agent_id=sender_id`）
- ACLは `task_assignment/review_result/aggregation_result/control/error` を全定義し、未定義は拒否する
- `task_assignment` は consume直後 `message_receipts` 永続化 + ACK（execution前）を必須とする
- `review_result` は consume直後 `message_receipts` 永続化 + ACK（duplicate時は `no-op + ack`）を必須とする
- 重複排除キー `task_id + agent_id + msg_id` は `state_root` 配下に永続化し、再起動後も有効にする

## 8. 並列レビューの制御ルール

1. task作成後、`task_assignment` を codex/claude に fan-out
2. 2件の `review_result` を待機（`quorum=all`）
3. 集約判定:
   - どちらかに `blocking > 0` があれば `FAIL`
   - 両方 `PASS` なら `PASS`
   - 判定不一致は `manual_review_required`
4. 集約結果を `aggregation_result` として `orchestrator` 宛に配信する
5. `orchestrator` が `aggregation_result` を消費し、最終状態遷移（done/rework/manual_review_required）を確定する

## 9. 受け入れ基準（PoC）

1. 1タスクに対し Codex/Claude 並列レビューが完了する
2. relay停止後の再起動で未送信outboxが再送される
3. duplicate message を受信しても状態遷移が重複しない
4. 署名不正 / nonce再利用 / ACL違反を拒否できる
5. hard timeout 到達タスクが dead-letter へ隔離される

## 10. 実装順（7ステップ）

1. schema追加（envelope / review_result / aggregation_result）
2. `TaskDomain` と `ProcessManager` の契約実装（wireはsnake_case、`tx/post_commit` 分離）
3. state store テーブル作成（tasks/events/outbox/message_receipts/nonces/execution_runs）
4. relay実装（ack/nack/retry/dlq）
5. provider adapter 実装（codex/claude）
6. aggregator 実装（quorum=all 判定）
7. E2E 3本（正常系 + crash復旧 + 署名/nonce/ACL異常系）

## 11. PoC v1 運用ゲート（最小）

1. `REVIEWER_AUTH_ERROR` は即時停止して認証修復。
2. `REVIEWER_NETWORK_ERROR` は2回まで再実行し、超過時は `manual_review_required`。
3. `REVIEWER_EXECUTION_ERROR` は raw output を必須添付して手動判定。
