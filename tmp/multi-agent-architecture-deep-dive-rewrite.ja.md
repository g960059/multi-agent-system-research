# マルチエージェント基盤再設計（モジュール化リライト案）

作成日: 2026-02-11  
対象: `docs/multi-agent-architecture-deep-dive.ja.md` の再構成案

---

この文書は、`docs/multi-agent-architecture-deep-dive.ja.md` を仕様主導で再構成したリライト案です。比較・レビューは含めず、実装に直接使う構成のみを記載します。

## 1. モジュール化リライト案

### 1.1 Goal / Non-goals / 制約 / SLO

### Goal

- LLM非依存で再現可能な制御層を実現する
- タスク競合・ファイル競合・再割当てを決定論的に扱う
- hooks有無に関係なく同一workflowを実行する

### Non-goals

- 特定ベンダーのhook仕様に最適化した実装を正本にしない
- exactly-once配送を最初から要求しない（複雑性過大）

### 制約

- ローカル実行中心（SQLite/libSQL前提）
- 一時的なagent停止・再起動は常態として扱う
- 仕様変更が速い領域（Agent Teams/Hooks）はadapterで吸収する

### SLO（初期）

- Task claim競合成功率: 99.9%
- 再起動後の復旧時間（RTO）: 60秒以内
- メッセージ重複処理の誤適用率: 0%（dedup前提）
- dead-letter率: 3%未満（週次観測）

---

### 1.2 アーキテクチャ方針（Control Plane中心）

```text
[Workflow DSL (YAML)]
        |
        v
[Compiler/Validator]
        |
        v
[Control Plane]
  - Orchestrator
  - Scheduler + Lease
  - Reservation Manager
  - Reliability Manager
  - Policy Engine (authoritative)
        |
        +--> [State Store: event_log + projections]  <-- SoT
        |
        +--> [Execution Adapters]
               - Hooks Adapter (Claude etc.)
               - External CLI Adapter
               - Team Runtime Adapter
```

設計原則:

- 正本は常に `State Store` の event log
- mailbox/filesystemは配送・可視化のための投影
- hooksは強制ポイントの一つ。強制ポリシー本体はControl Plane

---

### 1.3 モジュール一覧（責務分離）

#### M1. Workflow Compiler

- 入力: `workflow.yaml`
- 出力: 正規化済み実行計画（movement DAG、gate、retry policy）
- 不変条件: 参照先persona/policy/knowledgeの存在検証

#### M2. Orchestrator

- 入力: 実行計画 + イベント
- 出力: 状態遷移コマンド（claim/requeue/complete）
- 不変条件: 直接ファイル編集を行わない（制御専任）

#### M3. Scheduler / Lease Manager

- 入力: runnable task集合、worker heartbeat
- 出力: claim結果、lease更新、requeue判定
- 不変条件: claimは単一トランザクションで原子的

#### M4. Reservation Manager

- 入力: `reserve/release` 要求（path pattern, mode, ttl）
- 出力: grant/deny
- 不変条件: `exclusive` は任意重複を禁止

#### M5. Reliability Manager

- 入力: message送受信イベント
- 出力: ack/retry/dead-letter
- 不変条件: at-least-once配送 + dedup適用

#### M6. Policy Engine

- 入力: tool実行要求、task完了要求、idle遷移要求
- 出力: allow/deny/ask + reason
- 不変条件: hooksなしでも同一判定を返す

#### M7. Hook Adapter

- 入力: hooks event payload
- 出力: Policy Engine呼び出し + event正規化
- 不変条件: ベンダー仕様差分を吸収（Control Plane非依存）

#### M8. External Script Adapter

- 入力: CLIイベント/daemonイベント
- 出力: Policy Engine呼び出し + state更新
- 不変条件: hooks版と同一workflow semantics

#### M9. Team Lifecycle Manager

- 入力: team spec（role/count/model）
- 出力: spawn/drain/force-stop計画
- 不変条件: drain前に新規割当停止

#### M10. Projection / Observability

- 入力: event log
- 出力: dashboard, metrics, deadletter report
- 不変条件: 正本を書き換えず再生成可能

#### M11. Recovery Manager

- 入力: checkpoint / last good event offset
- 出力: restore plan
- 不変条件: 復旧は「再生」で行い、直接改ざんしない

---

### 1.4 正本データモデル（最小）

#### Task

```json
{
  "task_id": "t-123",
  "stage": "impl",
  "depends_on": ["t-100"],
  "status": "queued",
  "owner": null,
  "attempt_count": 0,
  "lease_until": null,
  "task_run_id": null,
  "fencing_token": 0,
  "idempotency_key": "sha256:...",
  "touched_paths": ["src/auth/**"],
  "priority": 50
}
```

#### Message Envelope

```json
{
  "msg_id": "uuid",
  "dedup_key": "task-123:r3:review_result",
  "from": "reviewer-1",
  "to": "coder-1",
  "type": "review_result",
  "ordering_scope": "task-123",
  "delivery_attempt": 1,
  "ack_at": null,
  "created_at": "2026-02-11T13:00:00Z",
  "payload": {}
}
```

#### Reservation

```json
{
  "reservation_id": "rsv-001",
  "agent": "coder-1",
  "patterns": ["src/auth/**"],
  "mode": "exclusive",
  "reason": "t-123 impl",
  "ttl_sec": 120,
  "expires_at": "2026-02-11T13:02:00Z"
}
```

---

### 1.5 タスク状態遷移（副作用安全）

状態:

- `queued -> claimed -> running -> review -> done`
- 失敗系: `running -> failed -> queued` / `failed -> deadletter`

必須ルール:

1. claim時に `task_run_id` と `fencing_token` を採番  
2. 外部副作用（git commit, file write）は `fencing_token` 検証後のみ許可  
3. requeue後に旧runの結果が到着したら `fencing_token` 不一致で破棄  
4. `idempotency_key` 一致の完了報告は再適用しない

---

### 1.6 通信信頼性契約

- 配送保証: at-least-once
- 重複対策: `dedup_key` で受信側除外
- 順序単位: `ordering_scope`（task単位）で単調増加検証
- ACK timeout超過:
  1. retry（指数backoff）
  2. 最大試行超過で dead-letter
  3. dead-letterはオペレータ介入可能

---

### 1.7 ファイル競合制御

優先順位:

1. reservation（shared/exclusive + TTL）
2. 必要時のみVCS lock（LFS lock等）

強制点:

- Write/Edit前に `Policy Engine` が reservation検証
- hooks環境では `PreToolUse` 経由、非hooks環境では adapter内で同等検証

---

### 1.8 Hooks統合方針（公式仕様準拠）

採用:

- `PreToolUse`: allow/deny/ask + updatedInput
- `TaskCompleted`: exit code 2 で完了拒否
- `TeammateIdle`: exit code 2 でidle拒否
- `SessionStart`/`PreCompact`/`SessionEnd`: 注入・整合・後始末

注意:

- Hookごとに制御方式が異なるため、共通抽象化はadapter側で実施
- ベンダー仕様更新時は adapter のみ更新し、Control Planeは不変

---

### 1.9 Team Lifecycle（招集/解散）

招集:

1. team spec登録
2. worker spawn
3. initial lease配布

解散（graceful）:

1. 新規割当停止
2. running drain
3. mailbox flush
4. 停止 + resource cleanup

解散（force）:

1. 即時停止
2. claimed/running を requeue
3. attempt上限判定で dead-letter 遷移

---

### 1.10 テスト戦略（最小）

- Unit: state transition, lease, dedup, reservation overlap
- Integration:
  - 同時claim競合（N worker）
  - lease失効後のfencing不一致破棄
  - hooks版/非hooks版の同値性
- E2E:
  - compaction想定の中断・復旧
  - team drain/force dissolve

成功条件:

- 競合時の二重完了 0件
- 復旧後のタスク取りこぼし 0件
- dead-letterへの誤遷移率 < 1%

---

### 1.11 導入順序（失敗モード優先）

1. Phase A: event log正本 + state machine + invariants
2. Phase B: lease/fencing/idempotency
3. Phase C: reservation + write gate
4. Phase D: mailbox reliability（ack/retry/dedup）
5. Phase E: hooks adapter / external adapter 同値化
6. Phase F: team lifecycle + throughput最適化

---

### 1.12 ロールバック方針

- feature flag で `old_runtime` / `new_control_plane` 切替
- event log は後方互換スキーマ（`schema_version`必須）
- 各Phaseで切戻し可能な停止点を定義

---

## 2. 参考文献対応表（全件）

| 文献 | 本リライトで採用した根拠 | 設計への反映 |
|---|---|---|
| Zenn: Claude Code Hooksをハック（zaico）https://zenn.dev/zaico/articles/d6b882c78fe4b3 | compactionで文脈が欠落し得る、ファイル正本 + 再注入が有効 | SessionStart/PreCompactとRecovery設計を明示 |
| Zenn: Agent TeamsとHooks統合（tarouimo）https://zenn.dev/tarouimo/articles/9aace19fa1c271 | Hook種別ごとにブロック方式が異なる、TaskCompleted/TeammateIdle/PreToolUseの実証 | Hook Adapterでイベント別判定を分岐 |
| multi-agent-shogun https://github.com/yohey-w/multi-agent-shogun | mailbox中心、`inotifywait` + `flock`、tmuxはnudge用途 | mailboxを通信層、tmuxを補助層として分離 |
| Swarm Tools docs https://www.swarmtools.ai/docs | libSQL + event sourcing、DurableMailbox/Lock、checkpoint/recovery、file reservation | SoTをevent log化、予約/復旧/耐障害設計を採用 |
| Claude Code Agent Teams docs https://code.claude.com/docs/en/agent-teams | shared task list, mailbox, file-lock claim, known limitations | 公式機能はadapter活用、制約は運用で吸収 |
| TAKT repo https://github.com/nrslib/takt | piece/movement、rules、parallel、max_iterations、pipeline | workflow DSLを正本化、実行系と分離 |
| Claude Hooks reference https://code.claude.com/docs/en/hooks | PreToolUseのallow/deny/ask + updatedInput、TaskCompleted/TeammateIdleはexit 2 | Hook制御仕様を最新版で定義 |
| Zenn: TAKT紹介 https://zenn.dev/nrs/articles/c6842288a526d7 | Faceted Prompting（Persona/Policy/Instruction/Knowledge/Output Contract） | モジュール境界とprompt資産分離の設計原則に採用 |

補足:

- Zenn記事の一部挙動は検証時点の仕様に依存する可能性があるため、制御仕様は公式ドキュメントを優先し、実運用上の落とし穴はZenn知見を補助根拠として扱う。
