# Mailbox PoC 進捗レビュー依頼（v3）

あなたは Staff+ レベルのソフトウェアアーキテクトです。  
以下のドキュメント群を、**実装着手直前の再レビュー**として評価してください。

## 前提（固定）

- workflow runtime は自前実装（TAKTは参照のみ）
- 実装言語は TypeScript（Node.js）
- まずは workflow module なしで mailbox-first PoC を成立させる
- 目的は「Codex + Claude の並列レビュー運用」を安全に回せる最小構成を固めること

## 直近で反映済みの進捗（今回の再レビュー前提）

1. `review_result` payload から `agent_id` を削除し、主体は envelope `sender_id` を正本化
2. `mailbox-envelope` で message `type` ごとの `sender_id` 制約を追加
3. aggregator / orchestrator の prompt と `output_schema_ref` 不整合を修正
4. orchestrator 出力専用に `process-manager-plan` schema を追加
5. assignment 処理を「consume直後 receipt 永続化 + ACK（execution前）」へ固定
6. ACL を全 message type で定義し `deny-by-default` を追加
7. `completion_notice` 不整合を廃止方向で統一（TaskCompletedは terminal 記録のみ）
8. 上位計画の古い envelope 例（`round_id` など）を PoC 準拠へ更新

## 必読ファイル

- `plan/00-module-boundary-and-interface-contract.ja.md`
- `plan/multi-agent-platform-plan.ja.md`
- `plan/mailbox-only-poc.ja.md`
- `plan/mailbox-poc-runtime.example.yaml`
- `plan/mailbox-poc-runbook.ja.md`
- `plan/process-manager-boundary.ja.md`
- `contracts/poc/process-manager-boundary.ts`
- `schemas/poc/mailbox-envelope.v1.schema.json`
- `schemas/poc/review-result.v1.schema.json`
- `schemas/poc/aggregation-result.v1.schema.json`
- `schemas/poc/agent-definition.v1.schema.json`
- `schemas/poc/domain-event.v1.schema.json`
- `schemas/poc/process-manager-command.v1.schema.json`
- `schemas/poc/process-manager-plan.v1.schema.json`
- `agents/agents.example.yaml`
- `prompts/reviewer/codex.md`
- `prompts/reviewer/claude.md`
- `prompts/reviewer/aggregator.md`
- `prompts/reviewer/orchestrator.md`
- `reviews/mailbox-poc-detailed-review-v2.ja.md`（参考）

## レビュー観点（重点）

1. 境界と疎結合
- `TaskDomain -> ProcessManager -> Ports/Adapters` 分離は実装時に維持可能か
- Mailbox / Spawn / Task の現実的な結合点は適切に限定されているか

2. 契約整合
- TypeScript 契約と JSON Schema が矛盾していないか
- `sender_id` 正本化方針が全レイヤで一貫しているか
- runner が envelope 包装する前提で prompt/schema の責務境界が明確か

3. 信頼性と復旧
- assignment ACK 戦略と visibility timeout が破綻しないか
- crash/retry/duplicate/dead-letter で無限ループや取りこぼしがないか

4. セキュリティ
- signature / nonce / ACL / principal binding に抜けがないか
- multi-agent 特有のなりすまし・改ざん・汚染経路を遮断できているか

5. 実装優先順位
- 今すぐ実装すべき最小セット（MVP）と後回し要件の切り分けは妥当か
- ローカルで再現・デバッグ可能な手順になっているか

## 出力形式（厳守）

1. Findings（重大度順: Critical / High / Medium / Low）
- 各項目に:
  - 影響
  - 根拠（ファイル名と該当箇所）
  - 具体的修正案
  - 代替案

2. Gate Judgment
- READY / NOT READY
- NOT READY の場合は「最小修正チェックリスト（5項目以内）」

3. Minimal Path
- mailbox-first 方針を維持した実装順（3〜7ステップ）

4. Optional Patch（任意）
- 追記可能な文章 or diff 案

## 依頼時の注意

- 確認や質問は不要。必要な前提は明示したうえでレビューを完結してください。
- 抽象論で終わらせず、実装に直結する指摘を優先してください。
