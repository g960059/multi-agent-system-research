# Process Manager 境界定義（Mailbox PoC向け）

作成日: 2026-02-11  
対象: `multi-agent-system-research`

## 1. 目的

Task system と Mailbox/Spawn の密結合を最小化するため、`Control Kernel` 内の責務を次の3層へ分離する。

1. `TaskDomain`（純粋な状態遷移）
2. `ProcessManager`（イベントを副作用コマンドへ変換）
3. `Ports/Adapters`（Mailbox/Outbox/Execution のI/O実装）

## 2. 非目標

- `TaskDomain` と `Mailbox` の識別子結合（`task_id`）をゼロにはしない
- `状態遷移 -> 通知` の因果結合は残す

## 3. 依存ルール

許可:

- `ProcessManager -> TaskDomainPort`
- `ProcessManager -> OutboxPort`
- `ProcessManager -> MailboxTransportPort`
- `ProcessManager -> ExecutionAdapterPort`

禁止:

- `TaskDomain -> MailboxTransportPort`
- `TaskDomain -> ExecutionAdapterPort`
- `MailboxTransportPort -> TaskState` 直接更新

## 4. 契約ファイル

- TypeScript契約: `contracts/poc/process-manager-boundary.ts`
- Domain Event schema: `schemas/poc/domain-event.v1.schema.json`
- Integration Command schema: `schemas/poc/process-manager-command.v1.schema.json`

## 5. Event -> Command 変換（最小）

1. `TaskAssigned` -> `tx: enqueue_outbox(task_assignment)`（実行開始はWorker Runner側）
2. `ReviewResultReceived` -> `tx: persist_message_receipt` + `post_commit: ack_message`
3. `ReviewQuorumReached` -> `tx: enqueue_outbox(aggregation_result)`
4. `TaskSoftTimedOut` -> `post_commit: request_cancel_execution`
5. `TaskHardTimedOut` -> `post_commit: force_stop_execution` + `tx: requeue_task`
6. `TaskCompleted` -> `tx/post_commit` 追加コマンドなし（terminal記録のみ）

## 6. Coupling Budget（設計の合格基準）

次を満たす限り、結合は許容範囲とみなす。

1. Mailbox実装を差し替えても `TaskDomain` は変更不要
2. `provider=codex/claude` の切替で `ProcessManager` は変更不要
3. Relay停止/再起動で `TaskDomain` の状態整合が崩れない
4. `TaskDomain` は unit test でI/Oモック不要

## 7. 実装メモ

- MVPは物理的に1プロセスでもよい（論理境界のみ先に固定）
- `ProcessManager` は「判断」ではなく「配線」に限定する
- LLM差分は `ExecutionAdapter` に閉じ込める

## 8. Tx / Post-Commit 実行規約

- ProcessManager が返す IntegrationCommand は2種類に分類する。
  - `tx_commands`: state/event/outbox/receipt/nonce 更新のみ（DBトランザクション内）
  - `post_commit_commands`: mailbox ack/nack、cancel/force-stop などの外部I/O
- Control Kernel は `tx_commands` を単一Txで確定し、commit成功時のみ `post_commit_commands` を実行する。
- rollback時は `post_commit_commands` を実行してはならない。
- 実行モデルは `pull` に固定する（`start_execution` command はPoC v1で使わない）。
- `task_assignment` は consume直後に `message_receipts` をtx永続化し、成功時に即時ackする。
- `review_result` も consume直後に `message_receipts` をtx永続化し、成功時に即時ackする（失敗時のみnack）。
- Worker Runner は assignment の ack 完了後に execution を開始する。
- `aggregation_result` の最終消費者は `orchestrator` に固定する。

## 9. Quorum状態と冪等性

- `TaskAggregate` は `required_reviewer_ids` と `received_review_results` を持つ。
- `quorum=all` は `required_reviewer_ids` 全員の受領で満たす。
- review result 冪等キーは `task_id + sender_id + msg_id` とする（`agent_id` カラムは `sender_id` 正規化値）。
- `message_receipts(agent_id, msg_id)` は一意制約で保存し、duplicateは `no-op + ack` とする（`agent_id=sender_id`）。
- dedup レコードは durable store に保存し、runtime再起動後も有効にする（PoC v1ではTTL自動削除なし）。

## 10. 署名・認可の正規化

- ACL主体は envelope `sender_id` に固定する（payload内主体は信頼しない）。
- `from` は `sender_id` と一致していなければならない（不一致は隔離）。
- `review_result` payload には `agent_id` を含めず、受信主体は `sender_id` から決定する。
- `review_result` / `aggregation_result` は `envelope.task_id == payload.task_id` を必須検証とし、不一致は隔離する。
- 署名検証は canonical JSON（`json_c14n_v1`）を前提にする。
- 鍵特定は `key_id` を使用し、`sender_id -> key_id -> principal` を一意化する。
