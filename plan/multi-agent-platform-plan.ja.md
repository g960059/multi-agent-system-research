# マルチエージェント基盤 計画書（背景・ユーザーストーリー・要件・アーキテクチャ）

作成日: 2026-02-11  
対象リポジトリ: `multi-agent-system-research`

## 0. 先行ドキュメント（必読）

実装前に、モジュール境界とインターフェース契約を先に凍結する。  
本計画書より先に、次を基準として適用すること。

- `plan/00-module-boundary-and-interface-contract.ja.md`

## 0.1 固定方針（この計画の前提）

- workflow エンジンは自前実装とする（TAKTは設計参照のみ）。
- 実装言語は TypeScript に統一する（Node.js runtime）。
- hooks は拡張経路として扱い、初期実装の主制御は外部runtimeで担保する。
- モジュール契約（command/event/envelope）を先に凍結し、実装は後追いで行う。

## 1. 背景

開発タスクを複数エージェントで並列処理すると、単純な「指示→実行」モデルでは次の問題が顕在化する。

- エージェント間のやり取りが増えるほど、会話コンテキストが肥大化しやすい。
- compact や再起動時に文脈乖離が発生し、判断の一貫性が崩れる。
- 並列実装時に同一ファイル編集が衝突し、修正の手戻りが増える。
- レビューNG時の差し戻しや再割当てを手作業で行うと、オペレーションが破綻する。
- エージェント停止時に「どのタスクが未完了か」を即時に復旧できない。

このため、マルチエージェントを実用化するには、以下を分離して設計する必要がある。

- 推論層（LLMが何を考えるか）
- 制御層（誰が何をいつ実行できるか）
- 通信層（誰に何をどう届けるか）
- 状態層（何が完了・失敗・再実行対象か）

本計画書は、上記課題に対して「workflow + task system + mailbox + runtime」を中核とする実装方針を定義する。

## 2. ビジョンとゴール

### 2.1 ビジョン

「エージェント数が増えても壊れない、再現可能で監査可能な開発運用基盤」を構築する。

### 2.2 目標

- 目標1: 役割分担された複数エージェントが、品質ゲートを満たすまで自律反復できる。
- 目標2: エージェント停止やコンテキスト乖離が起きても、状態から復旧できる。
- 目標3: hooks が使える環境でも使えない環境でも、同一 workflow 定義で運用できる。
- 目標4: ファイル競合とタスク競合を、明示的なロック/予約/leaseで制御できる。

### 2.3 非目標（今回やらないこと）

- 全判断を LLM orchestrator に委譲する設計。
- 端末I/O（tmux send-keys/capture-pane）を主通信路にする設計。
- 1回の実装で最適化（最初から複雑なイベント駆動基盤を作ること）。

## 3. 想定ユーザーとユーザーストーリー

## 3.1 ペルソナ

- ペルソナA: 開発リード
  - 複数エージェントの成果を最終品質基準で統合したい。
- ペルソナB: 実装担当エージェント（frontend/backend/test/doc）
  - 自分の担当タスクを衝突なく進めたい。
- ペルソナC: レビュー担当エージェント（security/performance/architecture）
  - 統一フォーマットで PASS/FAIL を返し、差し戻しを自動化したい。
- ペルソナD: 運用担当
  - 停止検知、再実行、監査ログ確認を低コストで行いたい。

## 3.2 ユーザーストーリー

- US-01
  - As 開発リード, I want 調査→要件→計画→実装→最終レビューをDAGで管理したい, so that 手戻りを減らせる。
- US-02
  - As 実装エージェント, I want 自分のタスクを claim して lease を更新したい, so that 重複実行を防げる。
- US-03
  - As 実装エージェント, I want 事前に file reservation を取ってから編集したい, so that 競合を回避できる。
- US-04
  - As レビューエージェント, I want blocking/non-blocking を区別して結果を返したい, so that 差し戻しを機械処理できる。
- US-05
  - As 運用担当, I want heartbeat と watchdog で停止検知したい, so that 自動再割当てできる。
- US-06
  - As 開発リード, I want hooks有無に関係なく同じ workflow 定義を使いたい, so that 環境依存を減らせる。
- US-07
  - As 運用担当, I want いつでも state store から進捗を再構築したい, so that compact後の文脈乖離に耐えられる。

## 4. 要件定義

## 4.1 機能要件

### FR-01 Workflow定義 `[MVP]`

- FR-01-1: workflow は YAML で宣言的に定義できること。
- FR-01-2: stage, dependency, gate, retry policy, iteration limit を記述できること。
- FR-01-3: parallel 実行ブロックを定義できること。

### FR-02 Task管理 `[MVP]`

- FR-02-1: タスク状態（queued/claimed/running/review/done/failed/deadletter）を持つこと。
- FR-02-2: claim は原子的に実行され、同一タスクの同時claimを防ぐこと。
- FR-02-3: lease と attempt_count を持ち、失効時に再キューできること。
- FR-02-4: depends_on 解決で実行可能タスクのみ配布されること。

### FR-03 通信（Mailbox） `[MVP]`

- FR-03-1: agentごとの inbox/outbox を持つこと。
- FR-03-2: メッセージは task_id / msg_id / parent_id / state_version を持つこと。
- FR-03-3: broadcast は orchestrator経由 fan-out のみ許可すること。
- FR-03-4: message schema 不正は拒否・隔離できること。

### FR-04 ファイル競合制御 `[MVP]`

- FR-04-1: touched_paths をタスク属性として持てること。
- FR-04-2: reservation（shared/exclusive）を取得しない編集を拒否できること。
- FR-04-3: reservation は TTL と更新機構を持つこと。

### FR-05 品質ゲート `[MVP]`

- FR-05-1: reviewer は PASS/FAIL を構造化で返すこと。
- FR-05-2: FAIL(blocking) の場合は差し戻しを自動化すること。
- FR-05-3: max_iterations 到達時に manual-review-required へ遷移すること。

### FR-06 障害復旧 `[MVP]`

- FR-06-1: heartbeat TTL 超過で worker停止を検知できること。
- FR-06-2: 停止workerの claimed/running を再キューできること。
- FR-06-3: リトライ上限超過時に dead-letter へ隔離できること。

### FR-07 チーム運用 `[Later]`

- FR-07-1: team定義（role/count/policy）で動的招集できること。
- FR-07-2: graceful/force の2種類で解散できること。
- FR-07-3: 招集/解散履歴を監査可能に記録すること。

### FR-08 実行系アダプタ `[MVP+Later]`

- FR-08-1 `[MVP]`: 外部script runtime で workflow を実行できること。
- FR-08-2 `[Later]`: hooks利用可能時は hooks adapter で gate を適用できること。
- FR-08-3 `[MVP]`: どちらの実行系でも task state の最終整合が同じになること。

## 4.2 非機能要件

- NFR-01 信頼性
  - メッセージ配送と状態遷移はクラッシュ耐性を持つこと。
- NFR-02 監査性
  - すべての状態遷移を追跡可能なログに残すこと。
- NFR-03 再現性
  - 同じ workflow と同じ入力で、同じ制御遷移が再現できること。
- NFR-04 可観測性
  - タスク数、失敗率、再試行回数、待機時間を観測できること。
- NFR-05 拡張性
  - 新しいagent種別やレビューゲートを追加しやすいこと。
- NFR-06 セキュリティ
  - シークレットはメッセージ本文に含めず参照IDで扱うこと。

## 4.3 制約

- 既存CLI環境（Codex/Claudeなど）が混在する可能性がある。
- hooks機能の有無・仕様は実行環境ごとに異なる。
- ネットワーク制限やローカル実行制約が環境により異なる。

## 4.4 採用判断（固定）

- TAKTは参照先として活用するが、workflow runtime自体は本プロジェクトで実装する。
- workflow DSLはYAMLで維持しつつ、実行は TypeScript 実装に一本化する。
- 将来 hooks が使える実行環境では adapter を追加し、workflow定義は再利用する。

## 5. 要件から導いたアーキテクチャ方針

要件を満たすため、以下の分離を採用する。

- workflow system
  - 何を行うか（定義）を保持
- task system
  - いつ誰が行うか（実行権）を管理
- mailbox system
  - どこへ届けるか（配送）を管理
- runtime/orchestrator
  - ポーリング、監視、再割当てを実行
- state store
  - すべての状態遷移を永続化
- hooks adapter（任意）
  - 利用可能環境での強制ゲートに接続

## 6. アーキテクチャ詳細

## 6.1 論理コンポーネント

### Component A: Workflow Engine

責務:

- workflow.yaml の検証
- DAG構築
- gate定義の読み込み

入力:

- workflow.yaml

出力:

- 初期taskセット
- stage遷移条件

### Component B: Task Orchestrator

責務:

- claim/lease/retry/reassign
- dependency解決
- scheduling

入力:

- task state
- reservation state
- heartbeat

出力:

- task assignment
- requeue/deadletter

### Component C: Mailbox Router

責務:

- inbox/outbox配送
- schema validation
- fan-out（broadcast制御）

入力:

- envelope message

出力:

- 正規化済みmessage

### Component D: Reservation Manager

責務:

- file reservation の発行/更新/解放
- 競合判定

入力:

- path patterns
- mode(exclusive/shared)

出力:

- reservation token
- conflict error

### Component E: Runtime Supervisor

責務:

- worker heartbeat監視
- crash検知と再起動
- lease timeout回収

入力:

- heartbeat table
- running tasks

出力:

- worker restart
- task requeue

### Component F: Hooks Adapter（オプション）

責務:

- workflow gate を hooks event に変換
- pre-tool deny/allow
- task completion block

入力:

- workflow rules
- runtime state

出力:

- hook execution decision

## 6.2 データモデル（最小）

### Task

```json
{
  "task_id": "task-001",
  "workflow_id": "wf-01",
  "stage": "backend_impl",
  "status": "queued",
  "depends_on": ["task-000"],
  "owner": null,
  "attempt_count": 0,
  "max_attempts": 3,
  "lease_until": null,
  "priority": 50,
  "touched_paths": ["src/api/**"],
  "created_at": "2026-02-11T00:00:00Z",
  "updated_at": "2026-02-11T00:00:00Z"
}
```

### Message Envelope

```json
{
  "msg_id": "msg-uuid",
  "task_id": "task-001",
  "from": "agent-backend-1",
  "to": "agent-reviewer-1",
  "type": "task_result",
  "round_id": "round-2",
  "parent_id": "msg-prev",
  "state_version": 14,
  "created_at": "2026-02-11T00:01:00Z",
  "payload": {}
}
```

### Reservation

```json
{
  "reservation_id": "res-001",
  "owner": "agent-backend-1",
  "paths": ["src/api/**"],
  "mode": "exclusive",
  "lease_until": "2026-02-11T00:10:00Z"
}
```

## 6.3 制御フロー

### Flow-01 通常実行

1. Workflow Engine が task DAG を生成
2. Task Orchestrator が runnable task を抽出
3. worker が claim（owner + lease）
4. Reservation Manager で touched_paths を予約
5. 実装/レビュー結果を mailbox で送信
6. gate判定後に done または rework を遷移

補足:

- Task module は mailbox を直接操作しない。
- `TaskCompleted` / `TaskFailed` などのイベントを発行し、Runtime/Worker が mailbox 配送を担当する。

### Flow-02 レビュー差し戻し

1. reviewer が FAIL(blocking) を返す
2. orchestrator が関連taskを rework ステージへ再投入
3. attempt_count と round_id を更新
4. max_iterations 超過なら manual-review-required

### Flow-03 worker停止復旧

1. Runtime Supervisor が heartbeat timeout を検知
2. 該当workerの claimed/running task の lease失効を確定
3. task を queued へ戻し、再割当て
4. retry上限超過は dead-letter

## 6.4 Broadcast制御

- 基本は unicast。
- broadcast は orchestrator のみ実行可能。
- broadcast返信は自動連鎖禁止。
- 集約方式（gather-and-reduce）を標準運用とする。

## 6.5 workflow.yaml 具体例（ユーザー提示フロー）

以下は「調査(3) -> 要件(1) -> 計画/レビュー(2) -> 実装(4)+常駐レビュー(2) -> 最終レビュー(3) -> NG差し戻し」の最小表現例。

```yaml
workflow_id: product-delivery-v1
version: 1
max_iterations: 3

gates:
  blocking_zero:
    type: reviewer_verdict
    pass_when: "blocking_count == 0"
    fail_signal: fail_blocking
  non_blocking_feedback:
    type: advisory
    pass_when: "true"
    fail_signal: none

artifacts:
  storage: state_store
  message_transport: mailbox_reference
  retention: until_workflow_complete

rework_policy:
  max_iterations_from: workflow.max_iterations
  on_max_reached: manual_review_required

stages:
  - id: research
    strategy: parallel
    agents: [market_researcher, paper_researcher, competitor_researcher]
    outputs: [research_report]

  - id: requirements
    strategy: single
    agents: [requirements_owner]
    depends_on: [research]
    outputs: [requirements_spec]

  - id: planning
    strategy: parallel
    agents: [planner, plan_reviewer]
    depends_on: [requirements]
    outputs: [implementation_plan, review_notes]

  - id: implementation
    strategy: parallel
    agents: [frontend_coder, backend_coder, doc_coder, test_coder]
    depends_on: [planning]
    touched_paths:
      frontend_coder: ["apps/web/**"]
      backend_coder: ["apps/api/**"]
      doc_coder: ["docs/**"]
      test_coder: ["tests/**"]
    outputs: [patches]

  - id: continuous_review
    strategy: service
    starts_with: implementation
    completion_trigger: implementation_done
    agents: [review_team, codebase_team]
    depends_on: [planning]
    gate: non_blocking_feedback

  - id: final_review
    strategy: parallel
    agents: [security_reviewer, performance_reviewer, architecture_reviewer]
    depends_on: [implementation, continuous_review]
    gate: blocking_zero

transitions:
  - from: final_review
    on: pass
    to: done
  - from: final_review
    on: fail_blocking
    to: implementation
```

実ファイル版: `plan/workflow.example.yaml`

補足:

- `outputs` は artifact ID として `state_store` に保存し、mailbox では参照IDを配送する。
- 差し戻し回数（attempt_count）は task module が管理し、workflow側は `rework_policy.max_iterations_from` で上限のみ規定する。

## 7. 実行戦略（hooks版 / 外部script版）

## 7.1 外部script版（標準）

- orchestrator daemon が task state を主導
- mailbox + state store で deterministic に動作
- hooks が無い環境でも同じ workflow を実行可能

## 7.2 hooks版（拡張）

- TaskCompleted / TeammateIdle で gate を強化
- PreToolUse で reservation未取得編集を拒否
- PreCompact で state capsule 再注入

## 7.3 両立のための設計ルール

- canonical は workflow.yaml
- hooks は adapter として後付け
- runtime state schema を共通化する

## 8. ポーリング・監視・タイムアウト設計

推奨初期値:

- inbox poll: 1-2秒
- idle backoff: 1 -> 2 -> 4秒（最大5秒）
- heartbeat更新: 10秒
- watchdog scan: 30秒
- heartbeat TTL: 30-45秒
- lease TTL: 60秒（20秒間隔で延長）

設計意図:

- 初期は単純な polling で可観測性を重視
- 運用で負荷課題が出た時点で event-driven 補助を追加

## 9. 品質ゲート定義（例）

必須ゲート:

- lint pass
- test pass
- secret scan pass
- security policy pass
- reviewer blocking findings = 0

任意ゲート:

- performance budget
- architecture consistency
- docs completeness

判定:

- PASS: 次ステージへ
- FAIL(non-blocking): 警告付きで進行可（ポリシー次第）
- FAIL(blocking): 差し戻し

## 10. ロードマップ

### Phase 0: 基盤雛形

- `plan/` に仕様策定
- TypeScript interface / schema 定義
- 単純 mailbox + taskテーブル

### Phase 1: 最小運用

- coder 1 + reviewer 1
- claim/lease/requeue
- dead-letter

### Phase 2: 競合制御

- file reservation 導入
- touched_paths 運用

### Phase 3: 並列化

- frontend/backend/test/doc の4並列
- broadcast制御 + 集約

### Phase 4: hooks統合

- hooks adapter 実装（任意）
- quality gate を hooks 側で強制

### Phase 5: 動的チーム

- summon/disband CLI
- team profile 管理
- 大規模DAG対応

## 11. 受け入れ基準（Acceptance Criteria）

- AC-01
  - 同一taskへの同時claimが発生しない。
- AC-02
  - worker停止時に60秒以内で再割当てされる。
- AC-03
  - touched_paths競合タスクが並列実行されない。
- AC-04
  - FAIL(blocking) が自動で差し戻しされる。
- AC-05
  - max_iterations 到達時に manual-review-required へ遷移する。
- AC-06
  - compact後でも state_version 整合で再同期できる。
- AC-07
  - hooks有無の2実行系で最終task状態が一致する。

## 12. 主要リスクと対応

- リスク1: メッセージ増大による処理遅延
  - 対応: broadcast制限、集約、TTL、圧縮
- リスク2: schema変更時の互換性
  - 対応: versioning + migration
- リスク3: 過剰な gate で throughput 低下
  - 対応: blocking/non-blocking 分離
- リスク4: 運用複雑化
  - 対応: CLI整備、runbook整備、段階導入

## 13. 実装候補（初期）

- language
  - orchestrator: TypeScript (Node.js)
  - CLI: TypeScript (Node.js, commander/yargs等)
- state store
  - SQLite（将来 libSQL へ拡張可能）
- mailbox
  - file-based（atomic rename + lock）
- worker runtime
  - tmux（常駐と復旧）

## 14. 参考実装との対応表

- Agent Teams
  - shared task list / mailbox / hooks連携の設計参考
- Hooks
  - 強制ゲート設計の参考
- multi-agent-shogun
  - mailbox運用と event-driven 実務の参考
- Swarm Tools
  - durable lock/reservation/checkpoint/recovery の参考
- TAKT
  - workflow DSL設計の参照（runtime実装は自前）

## 15. まとめ

この計画の中心は、次の一点に集約される。

- LLMを「判断の主体」に使い、制御の決定論は runtime が担保する。

具体的には、workflow を宣言的に定義し、task system が claim/lease/reassign を担い、mailbox が配送を担い、runtime supervisor が復旧を担う。hooks は利用可能な環境で強制力を追加するアダプタとして位置づける。

この分離により、環境差異（hooks有無）と運用負荷（障害復旧・再実行）に耐える基盤を段階的に構築できる。
