# マルチエージェント・オーケストレーション設計まとめ（Mailbox方式）

## 対象
本ドキュメントは、coder/reviewer を含む複数エージェント運用を mailbox ベースで実施するための設計判断をまとめたものです。

## 方針更新（2026-02-11）
- workflow runtime は自前実装とする（TAKTは設計参照のみ）。
- 実装言語は TypeScript（Node.js）に統一する。
- hooks は拡張アダプタとして扱い、主制御は外部runtimeで維持する。

関連ドキュメント:
- `plan/00-module-boundary-and-interface-contract.ja.md`
- `plan/multi-agent-platform-plan.ja.md`

## 1. 基本方針
- `tmux` はプロセス生存性（常駐・再接続・復旧）に使う。
- 通信は `~/.mailbox`（またはリポジトリ配下 mailbox）で行う。
- `tmux send-keys/capture-pane` を通信プロトコルにしない。
- orchestrator は **非LLM** とし、制御を決定論的にする。

## 2. なぜ通信路は tmux ではなく mailbox か
- tmux 直接I/Oはプロンプト状態依存で壊れやすい。
- ANSI制御文字やタイミング差でパースが不安定。
- mailbox は再実行、監査、冪等性、リトライ設計がしやすい。

## 3. 「mailbox運用を強制する」方法
`AGENTS.md` と skill はガイドであり、強制力は弱いです。強制は外部で実施します。

推奨レイヤー:
1. 外部 orchestrator/worker スクリプト（強制）
2. 実行制限（書込先・ネットワーク制限）
3. メッセージスキーマ検証 + 状態遷移検証
4. AGENTS.md / skill（補助）

## 4. Context増加と compaction 乖離への対策
### 実用上のベース
- compaction が起きず、タスク境界が明確なら「未読 inbox のみ読む」運用は成立する。

### 安全策（推奨）
- 各メッセージに以下を持たせる:
  - `task_id`, `msg_id`, `parent_id`, `state_version`, `summary_hash`
- agent は `last_seen_msg_id` を保持。
- 欠番やハッシュ不一致時は `resync-required` を返す。
- タスク正本として `state/<task_id>.md` を維持する。

これにより:
- 通常時: 未読のみで高速処理
- 異常時: 明示的に再同期

## 5. チーム通信と broadcast 制御
### 基本ルール
- 既定は unicast。
- broadcast は orchestrator 経由 fan-out のみ許可。

### 理由
- N人が全員に返信する連鎖で、メッセージが指数的に増えるのを防ぐため。

### ガードレール
- broadcast種別を限定（`announce`, `vote-request` など）。
- broadcast への自動返信を禁止。
- `round_id` と `max_replies_per_round=1` を適用。
- gather-and-reduce を優先:
  - 各agent -> orchestrator に1回返信
  - orchestrator が集約して1通を再配信

## 6. 動的チーム運用（招集/解散）
大規模フローでは動的運用が必要。ただし制御は決定論的にできる。

### 2層モデル
1. **制御層（非LLM orchestrator）**
   - `workflow.yaml` の状態遷移を実行。
   - 構造化フィールドのみ見て spawn/drain を決定。
2. **判断層（LLM agents）**
   - 実装・調査・レビューの中身を担当。
   - `PASS/FAIL`, `blocking`, `next_stage` など構造化で返す。

### チーム操作
- 招集: `team/<team_id>.json` を作成し、role/countに応じて worker 起動。
- 解散（graceful）: 新規受付停止 -> 実行中drain -> worker停止。
- 解散（force）: 即時停止し、lease中ジョブを再キュー。

## 7. Polling / Heartbeat / 復旧
まずはシンプルな polling で開始し、必要時に最適化する。

### 推奨間隔
- worker inbox poll: `1-2秒`
- idle時 backoff: `1s -> 2s -> 4s`（上限 `5s`）
- worker heartbeat: `10秒`
- orchestrator health scan: `30秒`
- heartbeat TTL: `30-45秒`

### lease モデル
- claim時: `lease_until` を設定（例: now + 60秒）
- worker: 定期更新（例: 20秒ごと）
- 期限切れ: orchestrator が再キュー

### 障害対応
- 状態遷移: `queued -> running -> done|failed|deadletter`
- リトライ上限を設定
- 上限超過は dead-letter 隔離
- workerクラッシュ時は tmux で respawn

## 8. 品質ゲート反復（Coder <-> Reviewer）
- reviewer は `PASS` / `FAIL` と `blocking/non-blocking` を返す。
- `FAIL(blocking)` の間は coder へ自動差し戻し。
- `max_iterations` 到達で `manual-review-required` へ遷移。
- gate例: tests/lint/security/secret scan。

## 9. 推奨サブシステム分割
次の4サブシステムで設計する:
1. `workflow`（段階遷移）
2. `mailbox`（配送）
3. `task`（状態、リトライ、lease、DLQ）
4. `runtime`（polling、heartbeat、監視）

## 10. 最小導入ステップ
1. coder 1 + reviewer 1 の mailbox 連携を先に実装。
2. heartbeat + lease + retry + dead-letter を追加。
3. team fan-out と動的 spawn/drain を追加。
4. polling負荷が課題になってから fswatch/inotify を導入。

## 11. Hooks について
- hooks は補助として有効だが、強制の中核には不足。
- Codex CLI では `notify` が使えるため、人間への通知に有効。
- オーケストレーションの信頼性は外部スクリプト側で担保する。

## 12. 結論
- 通信: mailbox
- 生存性: tmux
- 制御: 非LLM orchestrator
- 知的作業: LLM workers

この分離が、品質ゲート付き反復開発における安定性と柔軟性を両立させます。
