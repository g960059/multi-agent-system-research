# Mailbox-Only PoC Runbook（手動検証）

## 1. 事前準備

1. `tmp/poc-mailbox/state` と `tmp/poc-mailbox/mailbox` を作成する。
2. `mailbox` 配下に `inbox/codex`, `inbox/claude`, `inbox/aggregator`, `outbox`, `ack`, `deadletter` を作成する。
3. `plan/mailbox-poc-runtime.example.yaml` のパスを環境に合わせる。
4. `npm run build` が通ることを確認する。

## 2. 起動順（最小）

1. Control Kernel を起動（state管理 + outbox書き込み）。
2. Mailbox Relay を起動（outbox -> inbox 配送）。
3. Worker Runner を起動（`codex`, `claude`）。
4. Aggregator を起動（2結果集約）。

## 3. タスク投入

1. Control Kernel に `review task` を1件投入する。
2. `task_assignment` が `codex` と `claude` の inbox に配送されることを確認する。
3. worker が `task_assignment` consume直後に `message_receipts` 永続化 + ACK することを確認する。
4. 両workerが `review_result` を返すことを確認する。
5. `review_result` consume時に `message_receipts` 永続化 + ACK（duplicateは `no-op + ack`）となることを確認する。
6. Aggregator が `aggregation_result` を `orchestrator` 宛に返すことを確認する。
7. `orchestrator` が `aggregation_result` を消費し、最終状態遷移を確定することを確認する。
8. `message_receipts(agent_id, msg_id)`（`agent_id=sender_id`）が重複なしで記録されることを確認する。

## 4. Duration検証

1. CodexまたはClaudeの処理を意図的に遅延させ、`task_soft_timeout_sec=600` 到達時の中断要求を確認する。
2. `task_hard_timeout_sec=900` で強制終了し、`nack + requeue` されることを確認する。
3. `max_attempts=2` 超過で dead-letter へ移動することを確認する。

## 5. 復旧検証

1. review実行中に Relay を停止する。
2. outbox に未ackレコードが残ることを確認する。
3. Relay再起動後に未ackが再送されることを確認する。
4. duplicate assignment が起きても `message_receipts` 判定で `no-op + ack` になることを確認する。

## 6. セキュリティ検証

1. `signature` 不正メッセージを投入し、隔離されることを確認する。
2. 同一 `nonce` を再利用し、replay拒否されることを確認する。
3. `review_result` を `orchestrator` が送信したケースを投入し、ACL違反として拒否されることを確認する。
4. `key_id` 不一致ケースを投入し、署名検証失敗として拒否されることを確認する。
5. `review_result` / `aggregation_result` で `envelope.task_id != payload.task_id` のケースを投入し、隔離されることを確認する。

## 7. 実行コマンド（PoC実装）

1. ランタイム起動（1タスクの smoke 実行）:
   - `npm run poc:runtime -- --task-id task-runtime-smoke --instruction "normal review" --max-passes 12`
   - `task_assignment` には `git status/diff` を元にした `review_input_ref` / `review_input_excerpt` が自動付与される。
2. E2E実行:
   - `npm run poc:e2e`
3. 実CLI事前確認（認証/ネットワーク分類）:
   - `npm run poc:cli:auth:sync`
   - `npm run poc:cli:check`
   - `POC_CLI_HOME_MODE=host npm run poc:cli:check`（隔離HOMEを使わず既存ログインを使う場合）
   - `claude` が `auth_error` の場合は `HOME=tmp/poc-mailbox/state/cli-home claude` を実行し、`/login` を完了させる。
4. 実CLI起動（Codex/Claudeを使用）:
   - `npm run poc:runtime:cli -- --task-id task-runtime-cli-smoke --instruction "normal review"`
   - `--cli-home-mode host` で既存 `~` 認証情報を利用できる。
   - `--include-full-git-diff` 指定時のみ review 入力に full diff を含める（既定は summary のみ）。
   - モデル切替例:
     - `npm run poc:runtime:cli -- --task-id task-runtime-cli-models --instruction "normal review" --codex-model gpt-5.3-codex --claude-model claude-sonnet-4-5-20250929`
   - review入力サイズ調整例:
     - `npm run poc:runtime:cli -- --task-id task-runtime-cli-compact --instruction "normal review" --review-input-max-chars 80000 --review-input-excerpt-chars 16000`
   - CLIの状態保存先は既定で `tmp/poc-mailbox/state/cli-home`（HOMEを隔離）を使用する。

## 8. 運用ゲート（PoC v1）

1. `REVIEWER_AUTH_ERROR` が1件でも出た場合は実行継続せず認証修復を優先する。
2. `REVIEWER_NETWORK_ERROR` は最大2回まで再実行し、継続する場合は `manual_review_required` 扱いにする。
3. `REVIEWER_EXECUTION_ERROR` はランタイム不整合として記録し、再現手順と raw output をレビューに添付する。

## 9. 重複排除の保持境界

1. dedupキーは `task_id + agent_id + msg_id`。
2. `state/message-receipts.jsonl` に永続化し、同一 `state_root` での再起動後も有効。
3. PoC v1 はTTL自動削除を行わず、`state_root` クリーンアップ時にまとめて破棄する。
