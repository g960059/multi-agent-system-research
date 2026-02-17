# 全体抽象化の再設計 v3 (Swarm 参照でゼロベース)

最終更新: 2026-02-17  
対象: `multi-agent-system-research`

## 0. 前提にした外部参照

1. Swarm Tools: https://github.com/joelhooks/swarm-tools
2. Claude swarm orchestration skill gist: https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea

この2つから採用した本質は以下:

1. local-first で永続化される協調実行コンテキスト
2. 短命 subtask agent と常駐 teammate agent の併存
3. task 依存関係と inbox message による協調
4. event log ベースの再現可能性
5. 役割別 worker を並列に回す運用パターン

## 1. この再設計の目的

1. 並列 review だけでなく、並列 implement/refactor/research/test/document を同一抽象で扱う。
2. agent の種類が増えても kernel の責務を太らせずに拡張できる。
3. DX (定義の書きやすさ) と運用性 (再現性/復旧性) を同時に維持する。

## 2. 抽象化の中核

### 2.1 最上位概念

1. `SwarmRun`
2. `WorkflowSpec`
3. `WorkGraph`
4. `AgentProfile`
5. `TaskAttempt`
6. `Envelope`
7. `Artifact`
8. `OutcomePattern`

### 2.2 意味

1. `SwarmRun`: 1回の協調実行単位。team/task/message/policy snapshot を束ねる。
2. `WorkflowSpec`: 制御契約。phase/gate/loop/budget/decomposition policy を持つ。
3. `WorkGraph`: 実行計画。依存、優先度、要求 capability、reservation を持つ DAG。
4. `AgentProfile`: `provider/model/instruction/role/capabilities` の宣言。
5. `TaskAttempt`: claim された実行試行。lease と retry 文脈を持つ。
6. `Envelope`: agent 間通信の標準メッセージ。
7. `Artifact`: 中間/最終成果物。
8. `OutcomePattern`: 学習対象の実行結果パターン。

## 3. モジュール分割 (v3 提案)

`runtime` は composition root とし、以下を実モジュール化する。

1. `runspace`
2. `workflow-compiler`
3. `task-graph-engine`
4. `scheduler`
5. `agent-mesh`
6. `coordination-bus`
7. `state-ledger`
8. `artifact-memory`
9. `policy-governance`
10. `control-api`

### 3.1 各モジュール責務

1. `runspace`: SwarmRun のライフサイクル、team membership、run metadata を管理。
2. `workflow-compiler`: `WorkflowSpec -> WorkGraph seed` 変換。
3. `task-graph-engine`: task 状態遷移、依存解決、GraphDelta 適用。
4. `scheduler`: ready 集合から claim 対象を選抜。fairness と QoS を適用。
5. `agent-mesh`: agent spawn/heartbeat/shutdown、subtask と teammate の統一実行面。
6. `coordination-bus`: inbox/ack/nack/deferred/deadletter を提供。
7. `state-ledger`: append-only event log + projection + outbox を提供。
8. `artifact-memory`: artifact store と学習メモリ (pattern/anti-pattern) を提供。
9. `policy-governance`: policy snapshot、compatibility rule、admission rule を管理。
10. `control-api`: CLI/SDK/MCP からの command 入口。

## 4. subtask と teammate を同時に扱う抽象

Swarm 由来の重要点として、2種類の agent 実行形態を first-class で持つ。

1. `subtask` (短命): 1タスク専用。同期/非同期どちらも可能。
2. `teammate` (常駐): 複数タスクを継続処理。inbox と heartbeat を持つ。

両者は `TaskAttempt` 契約で統一し、違いは spawn policy だけに閉じる。

## 5. command/event の最小契約

### 5.1 Command

1. `CreateRun`
2. `RegisterAgent`
3. `CompileWorkflow`
4. `ApplyGraphDelta`
5. `ClaimTask`
6. `CompleteAttempt`
7. `FailAttempt`
8. `SendMessage`
9. `RequestPlanApproval`
10. `ApprovePlan`
11. `RequestShutdown`
12. `ApproveShutdown`

### 5.2 Event

1. `run_created`
2. `agent_registered`
3. `workflow_compiled`
4. `graph_delta_applied`
5. `task_claimed`
6. `attempt_completed`
7. `attempt_failed`
8. `message_sent`
9. `plan_approval_requested`
10. `plan_approved`
11. `shutdown_requested`
12. `shutdown_approved`
13. `outcome_recorded`

## 6. この設計の不変条件 (Kernel が守るべき最小)

1. すべての状態変更は `state-ledger` の append event を唯一ソースにする。
2. `WorkflowSpec` は epoch 単位で immutable。`WorkGraph` は導出状態。
3. GraphDelta は `policy-governance` と `task-graph-engine` の両方で検証して適用。
4. 1 task には同時に1つの有効 lease しか持てない。
5. idempotency key と lease fencing token なしに state mutation しない。
6. shutdown は request/approve handshakes でのみ完了する。

## 7. スケジューリング方針 (高レベル)

1. 基本は pull+lease。
2. tree fairness と service class を併用。
3. starvation SLO を明示 (`max_wait` か `min_share`)。
4. reservation conflict は scheduler でなく policy-governance で最終判定。
5. self-organizing swarm は `claim loop` policy で実現する。

## 8. workflow 表現力

この抽象で、以下を同一モデルで表現可能とする。

1. 並列 specialist review
2. research -> plan -> implement -> test -> review pipeline
3. plan の反復 review loop
4. implement 中の code/doc/test 並列協業
5. run 中の動的 decomposition
6. task pool を複数 worker が self-organizing claim

## 9. DX 設計 (agent 定義)

`agents.yaml` は最小入力を原則にする。

1. 必須: `id`, `role`, `provider`
2. 推奨: `model`, `instruction`, `capabilities`
3. 自動補完: `command_template`, `allowed_message_types`, `default_env_profile`
4. 例外 override は allowlist 方式で限定

これにより authoring 体験を軽くしつつ、policy drift を防ぐ。

## 10. 運用設計

1. `graceful shutdown sequence` を標準化。
2. crashed teammate は heartbeat timeout で inactive 化。
3. deadletter は redrive token 付きで再投入可能にする。
4. decision trace (`decision_id`, `cause_event_ids`, `policy_snapshot_id`) を標準化。

## 11. なぜこの再設計が前案より良いか

1. mailbox 単体ではなく `runspace` を導入し、team/task/message を一体管理できる。
2. subtask と teammate の二重モデルを同居させ、多様な運用に直接対応できる。
3. workflow と DAG の責務分離を維持しつつ、lineage と policy snapshot で運用再現性を確保できる。
4. module 境界が拡張方向 (provider/role/workflow type) と一致している。

## 12. 実装への落とし込み順 (最小)

1. `state-ledger` を中心に command/event 契約を固定する。
2. `runspace` と `agent-mesh` を先に導入し、subtask/teammate の両モードを通す。
3. `workflow-compiler` と `task-graph-engine` を分離し GraphDelta 経路を固定する。
4. 最後に `artifact-memory` の学習ループを追加する。

