# PoC Self Test 外部レビュー結果まとめ

- 実行日: 2026-02-12
- 対象: mailbox-first PoC（plan / src/poc / schemas/poc / prompts/reviewer）
- レビュー実行主体: PoC Runtime (`npm run poc:runtime:cli`) 経由の `codex + claude` 並列実行

## Run A（スコープ制約弱め）

- task_id: `task-selftest-20260212-012210`
- モデル:
  - codex: `gpt-5.3-codex`
  - claude: `claude-sonnet-4-5-20250929`
- 集約結果: `FAIL / manual_review_required / disagree=true`

所見:

- codex: `PASS`（blockingなし、non-blocking中心）
- claude: `FAIL`（blocking 5件）

解釈:

- claudeのblockingは、PoC範囲外（workflow/process manager/outbox本実装未着手）を「未実装欠陥」として評価したノイズが含まれる。

参照:

- `tmp/poc-mailbox/mailbox/ack/aggregator/8307e8f3-8051-4f17-825b-7ef03e57e8ac--1770827046646--2cd32227-8402-45a6-b154-3dd913d538f7.json`
- `tmp/poc-mailbox/mailbox/ack/aggregator/e86e01a2-9629-46dd-ab38-a2f77dca4b7f--1770827119759--bf9ae201-ef05-40de-89bd-40415cf8ac2e.json`
- `tmp/poc-mailbox/mailbox/ack/orchestrator/f59f7038-e2f6-4a19-820b-22a4d72ea6a5--1770827119763--0cf83035-de0b-4be1-b1de-bf975dfeb8fd.json`

## Run B（PoCスコープ明示）

- task_id: `task-selftest-scope-20260212-012603`
- モデル:
  - codex: `gpt-5.3-codex`
  - claude: `claude-sonnet-4-5-20250929`
- 集約結果: `PASS / proceed / disagree=false`

所見:

- codex: `PASS`、non-blocking 5件
- claude: `PASS`、non-blocking 3件
- いずれも「PoC継続を止める欠陥なし」で一致

参照:

- `tmp/poc-mailbox/mailbox/ack/aggregator/6c686a69-e68f-4594-91e7-bf6cda40e039--1770827244944--37bf581b-6a20-45fc-b73a-fa371bc35f90.json`
- `tmp/poc-mailbox/mailbox/ack/aggregator/53fc09ff-6868-4fc1-8847-3c39cf441f9a--1770827280297--866afd1b-0298-4f6f-99a6-412130df57ee.json`

## 採用推奨（実装者判断）

優先して採用:

1. sender主体の一意化（`from` と `sender_id` の整合ルール明記）
2. strict互換方針とN-1互換テストの整合（前提条件の明文化）
3. `task_id`整合チェック対象タイプの明文化（どこまで必須か）
4. 重複排除の耐久境界（再起動/TTL）定義
5. 運用ゲート（auth/network/error分類に対するSLO/閾値）定義

保留/スコープ外:

- workflow/process manager/outbox本実装未着手を blocking とする指摘（PoC段階では不採用）

## 反映状況（2026-02-12 追記）

- `from == sender_id` を runtime 受信検証へ追加（不一致は `SENDER_ID_MISMATCH` で隔離）。
- 互換性ポリシーを明確化:
  - PoC v1 は strict（未知フィールド拒否、N writer は N schema を対象）
  - N-1 互換テストは v2 以降の adapter 前提へ分離
- 重複排除の耐久境界を明記:
  - dedupキー `task_id + agent_id + msg_id`
  - `state_root` 配下永続、再起動後も有効
  - PoC v1 で TTL 自動削除なし
- 運用ゲートを追加:
  - auth/network/execution 分類カウント
  - runtime 出力 `reviewer_failure_counts` / `operational_gate`

## 実行確認（post-fix）

- `npm run poc:e2e`: PASS（3ケース）
  - happy path duplicate no-op+ack
  - task_id mismatch quarantine
  - from/sender_id mismatch quarantine
- `npm run poc:runtime:cli -- ... --codex-model gpt-5.3-codex --claude-model claude-sonnet-4-5-20250929 --cli-home-mode host`
  - 実行は完走
  - `reviewer_failure_counts.network_error=1`（Claude timeout）
  - `operational_gate=manual_review_network_retry`
