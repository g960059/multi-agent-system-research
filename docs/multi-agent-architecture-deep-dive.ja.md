# マルチエージェント基盤の再検討（詳細版）

作成日: 2026-02-11

## 1. このドキュメントの目的

この文書は、以下の観点でマルチエージェント基盤を再設計するための技術検討をまとめたものです。

- 強制力のあるワークフロー（品質ゲート、差し戻し、再実行）
- エージェント間通信の安定化（mailbox中心）
- タスクDAGの競合制御（claim/lease/reassign）
- ファイル競合の回避（reservation/lock）
- 動的なチーム招集・解散
- 将来の hooks 対応を見据えた設計（hooks版と外部script版の両立）

本稿は「何を採用するか」だけでなく、「なぜその結論に至ったか」を追えるように、比較・トレードオフ・判断手順まで明示します。

### 1.1 最新の固定方針（2026-02-11更新）

- TAKTは参照先として扱い、workflow runtime は自前実装とする。
- 実装言語は TypeScript（Node.js）に統一する。
- hooks は拡張経路として位置づけ、初期主制御は外部runtimeで担保する。

### 1.2 参照順序（実装時）

1. `plan/00-module-boundary-and-interface-contract.ja.md`（契約）
2. `plan/multi-agent-platform-plan.ja.md`（要件・段階導入）
3. `plan/workflow.example.yaml`（具体フロー例）
4. 本ドキュメント（背景比較と判断根拠）

---

## 2. 調査対象（一次情報）

今回の検討は、次の公開情報を基礎にしています。

1. Claude Code Hooks を使った自律駆動マルチエージェント（Zenn）  
   https://zenn.dev/zaico/articles/d6b882c78fe4b3
2. Agent Teams と Hooks の統合検証（Zenn）  
   https://zenn.dev/tarouimo/articles/9aace19fa1c271
3. multi-agent-shogun（GitHub）  
   https://github.com/yohey-w/multi-agent-shogun
4. Swarm Tools 公式ドキュメント  
   https://www.swarmtools.ai/docs
5. Claude Code Agent Teams 公式ドキュメント  
   https://code.claude.com/docs/en/agent-teams
6. TAKT（GitHub）  
   https://github.com/nrslib/takt

補助的に参照:

- Claude Code Hooks reference（公式）  
  https://code.claude.com/docs/en/hooks
- TAKT の背景説明（Zenn）  
  https://zenn.dev/nrs/articles/c6842288a526d7

---

## 3. 問題設定（今回の中核）

### 3.1 直面している課題

- context増加・compactionで文脈が飛ぶ
- agent間通信の信頼性（取りこぼし、順序、重複）
- タスク競合（誰がいつ実行権を持つか）
- ファイル競合（同一ファイル同時編集）
- agent停止時の再割当て
- 大規模フローでの動的チーム編成（招集/解散）

### 3.2 目標

- 決定論的に動く制御層を持つ
- 推論層（LLM）と制御層（runtime）を分離する
- hooks利用可否に依存しない設計にする
- 将来 hooks が増えても adapter 追加で追従できるようにする

---

## 4. 主要ソースの比較（強み/弱み）

## 4.1 Claude Agent Teams（公式）

要点（公式）:

- shared task list + inter-agent messaging + mailbox を提供
- task claim は file locking で race 回避
- TeammateIdle / TaskCompleted を hooks でゲート化できる
- known limitations が明示されている（resume不可、status lag、shutdown遅い、1 team/session、nested team不可、lead固定）

強み:

- 公式機能で導入が最速
- タスク依存と claim の基本機構がある
- hooks と統合しやすい

弱み:

- 実験機能で制約が明確
- 複雑な運用（大規模再配分、DLQ、lease制御）をそのままは表現しにくい
- セッション境界/復旧時の運用設計は別途必要

参照:  
https://code.claude.com/docs/en/agent-teams

## 4.2 Claude Hooks（公式）

要点（公式）:

- exit code と JSON output で制御
- PreToolUse は allow/deny/ask と updatedInput が可能
- TeammateIdle / TaskCompleted は exit code 方式でブロック可能
- PreCompact / SessionStart / SessionEnd などイベント面が広い

強み:

- 強制力を持てる（特にブロッキング）
- 品質ゲート、危険コマンド抑止、文脈注入の実装がしやすい

弱み:

- hooks だけで orchestrator 全体を置き換えるのは難しい
- 複雑な配車・再割当て・DLQなどは外部runtimeの方が明瞭

参照:  
https://code.claude.com/docs/en/hooks

## 4.3 Zenn（zaico / tarouimo）の実装知見

要点:

- 「AIにお願いする」のではなく、hooks/pipelineで強制する思想
- fileを真実の源泉にして context揮発を補償
- Agent Teams + Hooks 統合では、Hook種別ごとの挙動差が重要（PreToolUse, TaskCompleted, TeammateIdle など）
- compaction問題に対して再注入と永続状態管理を組み合わせる

強み:

- 実運用上の落とし穴が具体的
- 強制設計の実証がある

弱み:

- 設計が特定環境に寄る部分がある
- 仕様更新で挙動が変わる可能性がある

参照:  
https://zenn.dev/zaico/articles/d6b882c78fe4b3  
https://zenn.dev/tarouimo/articles/9aace19fa1c271

## 4.4 multi-agent-shogun

要点:

- mailbox中心（YAML + flock + inotifywait）
- tmuxは主通信ではなく「nudge」に限定
- event-drivenで idle 時CPUを抑える設計
- 役割階層（Shogun/Karo/Ashigaru）

強み:

- mailbox運用の実戦知見が豊富
- 「tmuxを通信路にしない」設計が現実的

弱み:

- YAMLベースは規模拡大時に検索性/集計性/一貫性でDBに劣る
- 複雑な競合制御は別層実装が必要

参照:  
https://github.com/yohey-w/multi-agent-shogun

## 4.5 Swarm Tools

要点:

- libSQL(embedded SQLite) + event sourcing
- DurableMailbox / DurableLock / ask() / checkpoint/recovery
- file reservation による競合回避

強み:

- durability と recovery が設計に組み込み済み
- 競合・再開・監査の考え方が強い

弱み:

- 既存CLI環境へ適用するにはアダプタ実装が必要
- 学習コストはやや高い

参照:  
https://www.swarmtools.ai/docs

## 4.6 TAKT

要点:

- piece/movement で workflow を宣言的に定義
- routing rules・parallel block・max_iterations を明示
- pipeline mode（branch作成/実行/commit/push/PR）
- persona/policy/knowledge/output contract の関心分離

強み:

- ワークフロー定義（何を強制するか）の表現力が高い
- human-in-the-loop と automation の切替がしやすい

弱み:

- 通信/再割当て/leaseなど runtime 面は別設計が必要
- orchestrator本体としては task runtime を補完する必要がある

参照:  
https://github.com/nrslib/takt  
https://zenn.dev/nrs/articles/c6842288a526d7

---

## 5. ここまでの比較から得た設計原則

1. 「推論」と「制御」を分離する  
   LLMは判断・生成、runtimeは状態遷移・排他・再実行を担当。
2. 真実の源泉は永続ストアに置く  
   会話文脈は揮発、状態は永続。
3. mailboxは通信路、tmuxは生存性担当  
   tmuxを主通信にしない。
4. 強制力は hooks と runtime で担保  
   プロンプト規約だけに依存しない。
5. workflow定義は実行系から分離  
   YAMLをcanonicalにし、hooks版/外部script版に投影する。

---

## 6. 推奨アーキテクチャ（結論）

### 6.1 全体像

```text
[Workflow DSL (YAML)]
        |
        | compile/adapter
        v
+------------------------------+
| Runtime Layer                |
| - Orchestrator (non-LLM)     |
| - Scheduler / Watchdog       |
| - Hook Adapter (optional)    |
+------------------------------+
        |                |
        |                +--> Hooks Runtime (Claude etc.)
        v
+------------------------------+
| Task System                  |
| - DAG, claim, lease, retry   |
| - dependency resolution       |
| - dead-letter                |
+------------------------------+
        |
        v
+------------------------------+
| Communication                |
| - mailbox (inbox/outbox)     |
| - unicast default            |
| - orchestrator fan-out       |
+------------------------------+
        |
        v
+------------------------------+
| State Store                  |
| - SQLite/libSQL (event log)  |
| - projections/materialized    |
+------------------------------+
```

### 6.2 なぜこの形か

- TAKTの強み（workflow表現）を参照しつつ、自前workflow DSL/runtimeを採用
- Swarm系の強み（durability/lock/recovery）を採用
- Agent Teams/Hooksの強み（公式統合、強制ゲート）をアダプタ層で活用
- Shogun系の強み（mailbox + event-driven + tmux補助）を通信運用に反映

---

## 7. DAG decomposition の設計

## 7.1 タスクモデル

最小フィールド:

- `task_id`
- `stage`（research/plan/impl/review 等）
- `depends_on[]`
- `status`（queued/claimed/running/review/done/failed/deadletter）
- `owner`（nullable）
- `attempt_count`
- `lease_until`
- `touched_paths[]`（予測ファイル集合）
- `priority`

## 7.2 実行可否判定

タスクを実行可能にする条件:

1. 依存タスクが done
2. ファイルreservation競合なし
3. claim可能（owner未確定、またはlease失効）

## 7.3 claim戦略

push配車より pull-claim を推奨:

- workerがキューから claim
- DBトランザクションでowner+leaseを原子的に更新
- 同時claimは1件だけ成功

理由:

- 分散時に単純で競合耐性が高い
- worker追加/減少に追従しやすい

---

## 8. ファイル競合の解決方針

### 8.1 結論

- 第一選択: reservation（shared/exclusive + TTL）
- 補助: 必要箇所だけ git lock（LFS lock等）

### 8.2 reservation設計

- `reserve(agent, patterns[], mode, reason, ttl)`
- `release(agent)`
- overlap判定:
  - `exclusive` は他の `shared/exclusive` と衝突
  - `shared` 同士は許可

### 8.3 運用ルール

- 実装タスク開始時に予約必須
- 予約なしWrite/Editは hooks で拒否可能
- 長時間タスクは lease更新を周期実行

---

## 9. タスク競合と再割当て

## 9.1 owner/lease

- claim時に `owner` と `lease_until` を設定
- heartbeat更新時に lease延長
- lease失効で自動 requeue

## 9.2 agent障害時

復旧手順:

1. watchdogが heartbeat TTL 超過を検知
2. そのagent所有の running/claimed を再キュー
3. `attempt_count++`
4. 上限超過で dead-letter
5. tmux respawn（必要なら）

## 9.3 実装場所

- workflow層: 定義のみ
- task/runtime層: claim/lease/reassign の本体
- hooks層: 入口ガード（必須条件未達の拒否）

---

## 10. mailbox 通信設計（推奨）

### 10.1 ディレクトリ例

```text
.mailbox/
  inbox/<agent>/
  outbox/<agent>/
  status/
  heartbeat/
  deadletter/
  logs/
```

### 10.2 メッセージ最小スキーマ

```json
{
  "msg_id": "uuid",
  "task_id": "task-123",
  "from": "reviewer-1",
  "to": "coder-1",
  "type": "review_result",
  "round_id": "r3",
  "state_version": 17,
  "parent_id": "msg-...",
  "payload": {"verdict":"FAIL","blocking":["..."]},
  "created_at": "2026-02-11T13:00:00Z"
}
```

### 10.3 broadcast制御

- デフォルト unicast
- broadcastは orchestrator のみ許可
- broadcast返信の自動連鎖を禁止
- gather-and-reduce（各agent→orchestrator→集約再配信）

---

## 11. polling / heartbeat / watch の基準値

初期値（まずはシンプルに）:

- inbox poll: 1-2秒
- idle backoff: 1 -> 2 -> 4秒（上限5秒）
- heartbeat: 10秒
- watchdog scan: 30秒
- heartbeat TTL: 30-45秒
- lease TTL: 60秒（20秒ごと延長）

将来:

- Linux系は inotify/fsevents で通知駆動へ
- ただし障害時の可観測性のため、polling fallbackは残す

---

## 12. 動的チーム招集・解散

## 12.1 招集

- `team/<id>.json` を生成
- role/count/model/policy を指定
- orchestrator が worker起動とtask配賦

## 12.2 解散（graceful）

1. 新規割当停止
2. 実行中タスクのdrain
3. mailbox flush
4. worker停止

## 12.3 解散（force）

- 即時停止
- claim中タスクを再キュー
- dead-letter条件を評価

---

## 13. Hooks版と外部script版の両立

## 13.1 Canonicalは workflow YAML

- `piece/movement/rules/gates` を1箇所で管理
- 実行系に応じて adapter で投影

## 13.2 Hooks版（Claude中心）

- TaskCompleted/TeammateIdle で quality gate
- PreToolUse で禁止操作・予約未取得編集の拒否
- PreCompact/SessionStart で再注入・整合チェック

## 13.3 外部script版（CLI中立）

- orchestrator daemon が状態遷移を実施
- mailbox + SQLite で claim/lease/retry を担保
- hooks がなくても同じworkflowを実行可能

## 13.4 変換可能な要素 / 難しい要素

変換しやすい:

- tool gate
- task completion gate
- idle gate
- context injection

変換しにくい:

- 動的なteam再編成ロジック全体
- 高度な再スケジューリング
- DLQポリシー

結論:

- "workflow -> hooks" は部分変換
- runtime主制御は外部で維持する

---

## 14. 「この推奨に至るまで」の判断プロセス

### Step 1: まず失敗モードを列挙した

- context drift
- file race
- task race
- worker crash
- message storm

### Step 2: 失敗モードごとに既存実装を照合した

- Agent Teams: task/mailbox/hooksは強いが制約あり
- Hooks: gate強制が強いが、全体オーケストレーションには不足
- Shogun: mailbox運用の実装知見が深い
- Swarm: durability と reservation が強い
- TAKT: workflow記述力が高く、DSL設計の参照として有効

### Step 3: 「どれを核にするか」を分離した

- Workflowの核: 自前workflow（TAKTはDSL設計の参照）
- Runtimeの核: Swarm系（状態管理）
- 統合の核: Agent Teams/Hooks（公式能力の活用）
- 運用知見: Shogun（通信実務）

### Step 4: LLM依存を最小化した

- orchestrator自体を非LLMにして決定論化
- LLMは「作業内容」に集中

### Step 5: 2実行系戦略にした

- hooks利用可能環境: hooks adapterで強化
- それ以外: 外部script/runtimeで同一workflow実行

この5段階で、拡張性と安定性のバランスを取りました。

---

## 15. 実装ロードマップ（現実的な導入順）

1. v0: 単一 coder/reviewer + mailbox + task schema（TypeScript）
2. v1: claim/lease/heartbeat/requeue/deadletter
3. v2: file reservation + write gate
4. v3: workflow YAML + external orchestrator
5. v4: hooks adapter（TaskCompleted/TeammateIdle/PreToolUse）
6. v5: team spawn/drain + broadcast制御 + 集約レポート

---

## 16. リスクと対策

### リスク

- 仕様変更（Agent Teams/Hooks）
- スキーマ増大で運用複雑化
- pollingコスト増加
- quality gate過剰で throughput 低下

### 対策

- adapter層分離で吸収
- schema versioning + migration
- event-driven化を段階導入
- gateを blocking/non-blocking に分離

---

## 17. 最終提言（短く）

- workflowは宣言的YAMLを正本にする
- orchestratorは非LLMで決定論化する
- task競合は claim+lease+watchdog で処理する
- file競合は reservation を第一選択にする
- hooksは強制ゲートとして活用する（ただし主制御は外部）

この方針なら、将来 Codex 側に hooks が来ても adapter を追加するだけで拡張できます。

---

## 18. 参考リンク

- Claude Hooks Hack（Zenn）  
  https://zenn.dev/zaico/articles/d6b882c78fe4b3
- Agent Teams × Hooks 検証（Zenn）  
  https://zenn.dev/tarouimo/articles/9aace19fa1c271
- multi-agent-shogun（GitHub）  
  https://github.com/yohey-w/multi-agent-shogun
- Swarm Tools docs  
  https://www.swarmtools.ai/docs
- Agent Teams（公式）  
  https://code.claude.com/docs/en/agent-teams
- Hooks reference（公式）  
  https://code.claude.com/docs/en/hooks
- TAKT（GitHub）  
  https://github.com/nrslib/takt
- TAKT紹介（Zenn）  
  https://zenn.dev/nrs/articles/c6842288a526d7
