# Mailbox PoC 後続ロードマップ（2026-02-12）

## 0. 現在地（完了）

- mailbox-first PoC の最小実行系（`src/poc/runtime.ts`）は稼働。
- Codex/Claude 並列レビュー、集約、最終判定までを1タスクで再現可能。
- 受信時の主要防御（ACL / signature / task_id一致 / duplicate no-op+ack）を実装済み。

## 1. 直近2週間（Phase 1: PoC Hardening）

目的: 「壊れ方が分かるPoC」に引き上げる。

1. `from == sender_id` 逸脱ケースを含むE2E異常系を固定（CIで常時実行）。
2. reviewer失敗分類（auth/network/execution）を運用ゲートに接続し、再実行方針を自動化。
3. CLI実行モードを2系統で安定化。
   - `cli-home-mode=isolated`（再現性重視）
   - `cli-home-mode=host`（既存ログイン優先）
4. review入力のデフォルトを summary-only とし、full diff は明示フラグに限定。

Exit Criteria:

- `npm run poc:e2e` が安定してPASS。
- `npm run poc:runtime:cli` で manual_review_required が発生しても原因分類が必ず出る。
- runbook 通りに第三者が再現可能。

## 2. 次の2〜4週間（Phase 2: Control Kernel 分離）

目的: mailbox PoC から「境界が守られた実装」へ移行。

1. `TaskDomain` 純粋関数実装を新規追加（I/O依存ゼロ）。
2. `ProcessManager` 実装を追加し、`DomainEvent -> tx/post_commit` をコード化。
3. runtime の直接分岐ロジックを段階的に `ProcessManager` に移管。
4. tx/post_commit のテストを追加（rollback時にpost_commit未実行を保証）。

Exit Criteria:

- `contracts/poc/process-manager-boundary.ts` の主要契約に対する実装が存在。
- Domain unit test は Mailbox/CLI モックなしで通る。
- relay/ack/nack の副作用が post_commit に限定される。

## 3. その次（Phase 3: State Store 実体化）

目的: ファイルPoCから durable state store へ。

1. SQLite 実装を追加（tasks/events/outbox/message_receipts/nonces）。
2. outbox relay を state store 駆動へ置換。
3. dead-letter / quarantine をDB監査可能に統合。
4. 再起動復旧テスト（crash直後再送）を自動化。

Exit Criteria:

- `状態遷移 + event + outbox` 同一Txがテストで検証済み。
- crash/restart で通知欠落ゼロ。

## 4. Workflow Module 着手条件（Go/No-Go Gate）

以下を満たすまで workflow module は着手しない。

1. Phase 1/2 の Exit Criteria を満たしている。
2. PoC運用での手動復旧コストを計測できている。
3. ProcessManager 境界での仕様変更頻度が低下している。

## 5. 今すぐ削る/後回し

今すぐ削る（PoC範囲外）:

- 動的team編成
- service stage の高度制御
- hooks adapter 本実装

後回し（Phase 3以降）:

- reservation本実装（glob競合最適化）
- workflow DSL拡張（式言語・高度gate）
- 本番向け分散実行最適化
