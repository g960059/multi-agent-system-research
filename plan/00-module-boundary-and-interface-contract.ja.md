# モジュール境界とインターフェース契約（Contract-First）

作成日: 2026-02-11  
対象: `multi-agent-system-research`

## 0. プロジェクト固定方針

- workflow runtime は自前実装（TAKTは設計参照のみ）。
- 実装言語は TypeScript（Node.js）に統一する。
- hooks は adapter 経由で後付け可能にし、主制御は外部runtimeで保持する。

## 1. 目的

本書は、実装前にモジュール境界と契約を固定し、疎結合を担保するための基準を定義する。

- 何をどのモジュールが所有するか
- どのインターフェースだけで連携するか
- どの変更が互換破壊になるか

## 2. 設計原則

- 契約先行（Contract-First）
  - 実装より先に API / Event / Schema を確定する。
- 単一責務（Single Responsibility）
  - モジュールは1つの中心責務を持つ。
- 所有権分離（Data Ownership）
  - エンティティごとに唯一の owner module を定義する。
- 一方向依存（Directional Dependency）
  - 上位は下位に依存、横依存はイベント経由を優先。
- 後方互換（Backward Compatibility）
  - schemaはversion付き、破壊変更は明示的移行を必須にする。

## 3. モジュール一覧と境界

## 3.1 Workflow Module

責務:

- workflow DSL の読込/検証
- DAG 展開
- gate/retry policy の解釈

所有データ:

- `workflow_definitions`
- `compiled_dag`

公開インターフェース:

- `CompileWorkflow(input: WorkflowYAML) -> CompiledWorkflow`
- `GetRunnableStages(workflow_id) -> Stage[]`

非責務:

- task claim / lease
- worker監視
- mailbox配送

## 3.2 Task Module

責務:

- task lifecycle 管理
- claim / lease / retry / dead-letter
- dependency 解決

所有データ:

- `tasks`
- `task_attempts`
- `task_transitions`

公開インターフェース:

- `CreateTasks(compiled_workflow) -> Task[]`
- `ClaimTask(worker_id, filters) -> Task | null`
- `HeartbeatTask(task_id, worker_id, lease_until) -> OK | Conflict`
- `CompleteTask(task_id, result) -> TransitionResult`
- `FailTask(task_id, reason) -> TransitionResult`
- `RequeueExpiredTasks(now) -> Count`

非責務:

- メッセージ配送
- file reservation 管理

## 3.3 Reservation Module

責務:

- touched_paths の競合判定
- shared/exclusive reservation の貸与/更新/解放

所有データ:

- `reservations`

公開インターフェース:

- `AcquireReservation(owner, paths, mode, ttl) -> Token | Conflict`
- `RenewReservation(token, ttl) -> OK | NotFound`
- `ReleaseReservation(token) -> OK`
- `CheckConflict(paths, mode) -> ConflictSet`

非責務:

- task状態管理
- workflow解釈

## 3.4 Mailbox Module

責務:

- envelope schema 検証
- inbox/outbox 配送
- unicast / fan-out 実行

所有データ:

- `messages`
- `mailbox_offsets`（未読位置）

公開インターフェース:

- `Publish(message) -> MessageId`
- `Consume(agent_id, max_n) -> Message[]`
- `Ack(agent_id, msg_id) -> OK`
- `Fanout(topic_or_team, message) -> MessageId[]`

非責務:

- task状態遷移
- worker lifecycle

## 3.5 Runtime Supervisor Module

責務:

- worker heartbeat監視
- crash検知と再起動
- lease timeout 回収トリガ

所有データ:

- `workers`
- `heartbeats`

公開インターフェース:

- `RegisterWorker(worker_spec) -> WorkerId`
- `UpdateHeartbeat(worker_id, ts) -> OK`
- `DetectStaleWorkers(now) -> WorkerId[]`
- `RecoverWorker(worker_id) -> RecoveryResult`

非責務:

- workflowコンパイル
- message payload 解釈

## 3.6 Gateway Module（Hooks / CLI Adapter）

責務:

- 外部実行系（hooks, CLI）との橋渡し
- input/output を内部契約へ変換

所有データ:

- なし（stateless推奨）

公開インターフェース:

- `TranslateHookEvent(raw_event) -> InternalCommand[]`
- `TranslateInternalDecision(decision) -> HookResponse`

非責務:

- ビジネスロジック（task判定など）

## 3.7 State Store Module

責務:

- トランザクション
- event log 永続化
- projection 更新

所有データ:

- DB schema 全体（ただし logical owner は各module）

公開インターフェース:

- `BeginTx/Commit/Rollback`
- `AppendEvent(event)`
- `QueryProjection(name, filters)`

非責務:

- オーケストレーション判断

## 4. 依存ルール

許可依存:

- Workflow -> Task
- Task -> Reservation
- Task -> Mailbox
- Runtime -> Task
- Gateway -> Task/Mailbox（変換のみ）
- 全モジュール -> State Store

禁止依存:

- Mailbox -> Task（逆参照禁止）
- Reservation -> Workflow
- Gateway -> Stateを直接更新（必ずTask/Mailbox経由）

## 5. 契約（Interface Contracts）

## 5.1 コマンド契約（Command）

例: `ClaimTask`

入力:

```json
{
  "worker_id": "worker-backend-1",
  "capabilities": ["backend", "typescript"],
  "filters": {"stage": "impl"},
  "request_id": "req-uuid"
}
```

出力:

```json
{
  "task": {
    "task_id": "task-123",
    "lease_until": "2026-02-11T16:00:00Z"
  },
  "status": "claimed"
}
```

エラー:

- `NO_TASK`
- `CONFLICT`
- `INVALID_FILTER`

## 5.2 イベント契約（Event）

共通ヘッダ:

```json
{
  "event_id": "evt-uuid",
  "event_type": "TaskClaimed",
  "event_version": 1,
  "occurred_at": "2026-02-11T15:00:00Z",
  "correlation_id": "task-123",
  "causation_id": "cmd-uuid",
  "producer": "task-module"
}
```

主要イベント:

- `TaskCreated`
- `TaskClaimed`
- `TaskLeaseRenewed`
- `TaskCompleted`
- `TaskFailed`
- `TaskRequeued`
- `ReservationAcquired`
- `ReservationConflict`
- `WorkerStaleDetected`

## 5.3 メッセージ契約（Mailbox Envelope）

```json
{
  "msg_id": "msg-uuid",
  "schema_version": 1,
  "task_id": "task-123",
  "from": "reviewer-1",
  "to": "coder-1",
  "type": "review_result",
  "state_version": 12,
  "parent_id": "msg-prev",
  "payload": {
    "verdict": "FAIL",
    "blocking": ["missing test"],
    "non_blocking": []
  }
}
```

必須ルール:

- `schema_version` 必須
- `task_id` 必須
- `msg_id` は全体で一意
- 未知フィールドは読み飛ばし（forward compatibility）

## 5.4 TypeScript インターフェース例（実装契約）

```ts
export interface TaskModule {
  createTasks(input: CompiledWorkflow): Promise<Task[]>;
  claimTask(input: ClaimTaskCommand): Promise<ClaimTaskResult | null>;
  renewLease(input: RenewLeaseCommand): Promise<void>;
  completeTask(input: CompleteTaskCommand): Promise<TransitionResult>;
  failTask(input: FailTaskCommand): Promise<TransitionResult>;
  requeueExpiredTasks(input: RequeueExpiredTasksCommand): Promise<number>;
}

export interface ReservationModule {
  acquire(input: AcquireReservationCommand): Promise<ReservationToken>;
  renew(input: RenewReservationCommand): Promise<void>;
  release(input: ReleaseReservationCommand): Promise<void>;
  checkConflict(input: CheckConflictQuery): Promise<ConflictSet>;
}

export interface MailboxModule {
  publish(input: PublishMessageCommand): Promise<string>;
  consume(input: ConsumeMessagesQuery): Promise<MessageEnvelope[]>;
  ack(input: AckMessageCommand): Promise<void>;
  fanout(input: FanoutCommand): Promise<string[]>;
}
```

## 6. 互換性ポリシー

- Minor変更
  - optional field 追加のみ許可
- Major変更
  - required field 変更、意味変更、削除
  - migration plan と dual-read 期間を必須化

バージョン戦略:

- `schema_version` を envelope/event/command それぞれに持つ
- adapter で old/new 変換を許容

## 7. 疎結合を守る開発ルール

- Rule-01: モジュール外テーブルの直接更新禁止
- Rule-02: モジュール間連携は公開インターフェース経由のみ
- Rule-03: payloadにロジックを埋め込まない（判定は受信側）
- Rule-04: retryは idempotent key 前提
- Rule-05: broadcast は orchestratorのみ
- Rule-06: hooksは gateway adapter からのみ接続

## 8. テスト戦略（契約中心）

- Contract Test
  - command/event/envelope schema を固定テスト
- Compatibility Test
  - N-1 schema reader で N writer を読めること
- Concurrency Test
  - 同時 claim / 同時 reservation 競合試験
- Recovery Test
  - worker crash -> lease失効 -> requeue を再現
- End-to-End Test
  - workflow1本の成功/差し戻し/失敗を通す

## 9. 実装順（Interface-First）

1. `schemas/` に command/event/envelope JSON Schema を定義
2. `contracts/` に TypeScript interface (`*.ts`) を定義
3. state store migration を確定
4. Task/Reservation/Mailbox の順に最小実装
5. Runtime Supervisor 実装
6. Gateway（hooks/CLI）実装
7. E2E と chaos test を追加

## 10. 完了条件（Definition of Done）

- モジュール間の依存違反がない
- 全公開インターフェースに契約テストがある
- 互換性テスト（N-1）を通過
- crash/recovery シナリオが再現・自動検証できる
- workflow実行で task/message/reservation が監査可能

## 11. 既存計画との関係

本書は、`multi-agent-platform-plan.ja.md` の先頭設計文書として扱う。  
実装時は、本書の契約を凍結してから各モジュール開発を開始する。
