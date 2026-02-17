# Mailbox PoC モジュール整理メモ（2026-02-12）

## 1. 目的

`src/poc/runtime.ts` に集中していた責務を、mailbox運用で重要な境界ごとに分離する。

## 2. 追加したモジュール

1. `src/poc/modules/agent-adapter.ts`
   - reviewer agent の抽象定義（`id / provider / model / instruction / display_name`）
   - Runtime 用 agent 構成の正規化
   - type別 ACL 生成
2. `src/poc/modules/envelope-policy.ts`
   - envelope 署名計算（canonical JSON）
   - envelope 検証（`from==sender_id`, ACL, route, task_id整合）

## 3. runtime 側の整理ポイント

1. reviewer 固定配列を廃止し、`reviewerProfiles` で動的化。
2. `runOnePass()` は reviewer 定義を走査して処理。
3. assignment payload に `reviewer_profile` を格納し、agentごとの `instruction` を注入。
4. provider adapter は `codex/claude` を `reviewer.provider` で切替。
5. `runtime-main` は `--agent-profiles-json`（reviewer配列）または`--agents-config-json`（agent-definition全文）で構成を差し替え可能。

## 4. テスト観点

1. `src/poc/e2e.ts`
   - custom reviewer 3種（security/performance/architecture）で mailbox fan-out と集約を検証。
2. `agents/skills/mailbox-parallel-review/scripts/run_parallel_review.test.mjs`
   - skill スクリプトの mailbox integration（deterministic）を検証。

## 5. 補足

- 既存 PoC の `FileMailbox` / `FileStateStore` は維持しつつ、agent/validation の変更点を先にモジュール化した。
- 次段階では `runtime.ts` から mailbox/state 実装本体の分離を進めると、`TaskDomain -> ProcessManager -> Ports/Adapters` 境界へ移行しやすい。

## 6. agents.yaml の簡素化方針（次段階）

意図:

- `command_template` は provider/role からほぼ決まるため、毎回YAMLに書かない。
- `allowed_message_types` も role から決まるため、自動設定を基本にする。

提案:

1. YAML最小必須は `id / role / provider` に絞り、`model / instruction / prompt_file` は任意にする。
2. `command_template` と `allowed_message_types` は `provider x role` の policy table から自動補完。
3. 例外時のみ override を許可（`command_template_override`, `allowed_message_types_override`）。
4. `env` は自由入力ではなく、`env_profile` + `env_overrides(allowlist)` を推奨。

理由:

- authoring コストを下げつつ、実行差異を減らせる。
- 変更点を「agentの意図（role/model/instruction）」に集中できる。
