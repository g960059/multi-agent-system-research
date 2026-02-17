# Workflow/Task 抽象化 再設計案 v3

最終更新: 2026-02-17  
対象: `multi-agent-system-research`  
方針: mailbox-first PoC を、長期運用できる swarm 実行基盤へ進化させる。

## 0. 参照した外部コンテキスト

1. Swarm Tools: https://github.com/joelhooks/swarm-tools
2. Claude swarm orchestration skill gist: https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea

この2つから取り入れる中核は以下。

1. local-first で永続化される team/task/message 状態
2. 短命 subtask agent と常駐 teammate agent の併用
3. task dependency + inbox message による協調
4. event log を中心にした復元可能性
5. 並列 specialist pattern と pipeline pattern の共存

## 1. 目的

1. 並列 review だけでなく、implement/refactor/research/test/document を同じ抽象で扱う。
2. agent 種別が増えても runtime monolith に戻らないモジュール境界を作る。
3. DX と運用性を同時に保つ。

## 2. 最上位抽象

1. `SwarmRun`: 実行単位。team/task/message/policy snapshot を束ねる。
2. `WorkflowSpec`: 制御契約。phase/gate/loop/budget/decomposition policy を持つ。
3. `WorkGraph`: 実行計画。依存、優先度、capability、reservation を持つ DAG。
4. `AgentProfile`: `provider/model/instruction/role/capabilities` を持つ agent 宣言。
5. `TaskAttempt`: lease と retry 文脈を持つ実行試行。
6. `Envelope`: agent 間通信の標準契約。
7. `Artifact`: 中間/最終成果物。
8. `OutcomePattern`: 成功失敗パターンの学習対象。

## 3. モジュール分割 (v3)

`runtime` は composition root に限定し、以下を明示モジュール化する。

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

## 4. 各モジュール責務

1. `runspace`: SwarmRun の lifecycle と team membership を管理。
2. `workflow-compiler`: `WorkflowSpec -> WorkGraph seed` を生成。
3. `task-graph-engine`: task lifecycle、dependency、GraphDelta 適用を管理。
4. `scheduler`: ready 集合から claim 対象を選び、fairness/QoS を適用。
5. `agent-mesh`: agent spawn/heartbeat/shutdown と attempt 実行を管理。
6. `coordination-bus`: inbox/ack/nack/defer/deadletter を提供。
7. `state-ledger`: append-only event + projection + outbox を提供。
8. `artifact-memory`: artifact 管理と outcome pattern 管理を提供。
9. `policy-governance`: policy snapshot と admission/authorization を管理。
10. `control-api`: CLI/SDK/MCP 入口を提供。

## 5. subtask と teammate の同居

agent 実行形態を first-class で2種類持つ。

1. `subtask`: 1タスク向け短命 worker。
2. `teammate`: 複数タスクを継続処理する常駐 worker。

違いは spawn policy に閉じ、共通実行契約は `TaskAttempt` で統一する。

## 6. command/event の最小契約

### 6.1 Command

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

### 6.2 Event

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

## 7. Kernel 不変条件

1. 状態変更の唯一ソースは `state-ledger` の append event。
2. `WorkflowSpec` は epoch 単位で immutable。`WorkGraph` は導出状態。
3. GraphDelta は `policy-governance` と `task-graph-engine` の双方で検証。
4. 1 task の有効 lease は同時に1つ。
5. idempotency key と lease fencing token がない mutation は拒否。
6. shutdown は request/approve handshake でのみ成立。

## 8. スケジューリング方針

1. 基本は pull+lease。
2. fairness は tree 単位と service class を併用。
3. starvation SLO (`max_wait` または `min_share`) を契約化。
4. reservation conflict は policy-governance が最終判定。
5. self-organizing swarm は claim loop policy として表現。

## 9. 表現可能な workflow

1. 並列 specialist review
2. `research -> plan -> implement -> test -> review` pipeline
3. plan の反復 review loop
4. implement 中の code/doc/test 並列協業
5. run 中の動的 decomposition
6. 複数 worker による task pool self-organizing claim

## 10. DX 設計 (agents 定義)

`agents.yaml` は最小入力を原則にする。

1. 必須: `id`, `role`, `provider`
2. 推奨: `model`, `instruction`, `capabilities`
3. 自動補完: `command_template`, `allowed_message_types`, `default_env_profile`
4. override は allowlist 方式に制限

## 11. 運用設計

1. graceful shutdown sequence を標準化。
2. crashed teammate は heartbeat timeout で inactive 化。
3. deadletter は redrive token 付きで再投入可能にする。
4. decision trace (`decision_id`, `cause_event_ids`, `policy_snapshot_id`) を必須化。

## 12. 実装優先順

1. `state-ledger` 中心に command/event 契約を先に固定。
2. `runspace` + `agent-mesh` で subtask/teammate の両モードを接続。
3. `workflow-compiler` と `task-graph-engine` を分離して GraphDelta 経路を固定。
4. `scheduler` と `policy-governance` の QoS/fairness 契約を導入。
5. `artifact-memory` の学習ループを最後に導入。

## 13. 旧案との要点差分

1. mailbox 中心から runspace 中心へ移行。
2. workflow/DAG 分離は維持しつつ lineage と policy snapshot を前提化。
3. review 最適化 PoC から、多用途 swarm 実行基盤へ責務を拡張。
