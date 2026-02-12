# 包括レビュー依頼プロンプト（引き継ぎサマリ付き）

## 1. ここまでの流れ（引き継ぎ）

- 本プロジェクトは、マルチLLMエージェント運用基盤を TypeScript/Node.js で自前実装する方針。
- 初期設計レビューで、以下の Critical を先に解消した。
  - `Task状態遷移 + Event追記 + Outbox追加` の同一トランザクション確定（Transactional Outbox 方針）
  - メッセージ認証/改ざん対策（`sender_id`, `sender_instance_id`, `issued_at`, `nonce`, `signature`, ACL）
- 「workflow module を後回し」にして、まず mailbox 中心で Codex + Claude 並列レビューPoCを成立させる方針に変更した。
- そのために、PoC設計・runtime設定・schema・agent定義・Process Manager境界を追加した。

## 2. 今回レビューしてほしい対象（必読）

### 既存計画（更新あり）
- `plan/00-module-boundary-and-interface-contract.ja.md`
- `plan/multi-agent-platform-plan.ja.md`
- `plan/workflow.example.yaml`

### PoC追加
- `plan/mailbox-only-poc.ja.md`
- `plan/mailbox-poc-runtime.example.yaml`
- `plan/mailbox-poc-runbook.ja.md`
- `plan/process-manager-boundary.ja.md`

### 契約/スキーマ/定義
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

## 3. 別agentに渡すレビュー依頼プロンプト（このまま使用可）

```md
あなたは Staff+ レベルのソフトウェアアーキテクトです。
以下のドキュメント群を、実装前の包括設計レビューとして評価してください。

前提:
- workflow runtime は自前実装（TAKTは参照のみ）
- 実装言語は TypeScript（Node.js）
- まずは workflow module を後回しにし、mailbox中心 PoC を成立させる
- 直近で Critical 対応として「同一Tx outbox」と「メッセージ認証/改ざん対策」を追加済み

必読ファイル:
- plan/00-module-boundary-and-interface-contract.ja.md
- plan/multi-agent-platform-plan.ja.md
- plan/workflow.example.yaml
- plan/mailbox-only-poc.ja.md
- plan/mailbox-poc-runtime.example.yaml
- plan/mailbox-poc-runbook.ja.md
- plan/process-manager-boundary.ja.md
- contracts/poc/process-manager-boundary.ts
- schemas/poc/mailbox-envelope.v1.schema.json
- schemas/poc/review-result.v1.schema.json
- schemas/poc/aggregation-result.v1.schema.json
- schemas/poc/agent-definition.v1.schema.json
- schemas/poc/domain-event.v1.schema.json
- schemas/poc/process-manager-command.v1.schema.json
- schemas/poc/process-manager-plan.v1.schema.json
- agents/agents.example.yaml
- prompts/reviewer/codex.md
- prompts/reviewer/claude.md
- prompts/reviewer/aggregator.md
- prompts/reviewer/orchestrator.md

レビュー観点（重要）:
1. 必要性とスコープ
- mailbox-only PoC は妥当か
- 過剰設計/不足設計はどこか

2. 疎結合性の実効性
- TaskDomain / ProcessManager / Ports の分離は実装上ワークするか
- 依存逆転が崩れるポイントはどこか

3. 契約品質
- TypeScript契約とJSON schemaの整合
- provider差分（codex/claude）吸収が可能か
- 互換性戦略（schema versioning）に穴はないか

4. 信頼性/復旧
- outbox relay、ack/nack、retry、dead-letterが破綻しないか
- timeout/lease設定は妥当か

5. セキュリティ
- nonce/signature/ACL設計に抜けがないか
- なりすまし・replay・prompt汚染への耐性は十分か

6. 実装順序とDX
- 実装順は現実的か
- ローカル検証/再現/デバッグしやすいか

要件:
- 確認や質問は不要。必要な前提は明示して完結してください。
- 抽象論ではなく、実装に直結する指摘にしてください。
- 根拠は必ずファイルパスと該当箇所で示してください。

出力形式（厳守）:
1. Findings（重大度順: Critical / High / Medium / Low）
   - 各項目に: 影響 / 根拠（ファイル名+箇所） / 具体的修正案 / 代替案
2. Gate Judgment
   - READY / NOT READY
   - NOT READY の場合は最小修正チェックリスト（5項目以内）
3. Minimal Path
   - 今の方針を維持した最短実装ステップ（3〜7ステップ）
4. Optional Patch
   - 追記できる文章または差分案（任意）
```
