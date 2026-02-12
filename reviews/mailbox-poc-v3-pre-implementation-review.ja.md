# Mailbox PoC 進捗レビュー（v3 / 実装着手直前）

作成日: 2026-02-11  
対象リポジトリ: `multi-agent-system-research`

## 1. Findings（重大度順）

1. **Critical: `ProcessManagerPlan` の TS 契約と JSON Schema が不整合**  
影響: orchestrator 出力を schema で受けると通るが、TS 契約では同一構造として扱えず実装時に破綻する。  
根拠: `contracts/poc/process-manager-boundary.ts:279`, `schemas/poc/process-manager-plan.v1.schema.json:8`, `schemas/poc/process-manager-plan.v1.schema.json:25`, `prompts/reviewer/orchestrator.md:5`  
具体的修正案: `ProcessManagerPlan` に `schema_version: 1` を追加し、schema と完全一致させる。  
代替案: schema 側から `schema_version` を外す（ただし versioning 方針と逆行）。

2. **High: envelope `task_id` と payload `task_id` の整合検証が契約化されていない**  
影響: `sender_id` 正本化はできても、`task_id` すり替えで別タスク汚染のリスクが残る。  
根拠: `schemas/poc/mailbox-envelope.v1.schema.json:15`, `schemas/poc/mailbox-envelope.v1.schema.json:141`, `schemas/poc/review-result.v1.schema.json:11`, `schemas/poc/aggregation-result.v1.schema.json:11`, `plan/mailbox-only-poc.ja.md:104`  
具体的修正案: 受信時の必須検証として `envelope.task_id == payload.task_id` を追加し、不一致は隔離。  
代替案: payload から `task_id` を削除して envelope 側に一本化。

3. **High: execution 起動責務が二重化しており、実装時に重複起動/未起動を誘発**  
影響: `TaskAssigned -> start_execution` と「worker が inbox consume 後に実行」の両モデルが混在し、実装で分岐事故が起きる。  
根拠: `plan/process-manager-boundary.ja.md:42`, `plan/mailbox-only-poc.ja.md:29`, `plan/mailbox-poc-runbook.ja.md:20`, `plan/mailbox-poc-runtime.example.yaml:13`  
具体的修正案: 起動モデルを1つに固定（推奨: pullモデル。consume+receipt+ack後に実行開始）。  
代替案: pushモデルに寄せるなら consume/ack 戦略記述を削除し、`start_execution` のみ正とする。

4. **High: `aggregation_result` の最終消費者が契約上あいまい**  
影響: 集約結果が配信されても誰が最終遷移を確定するか不明で、PoC 完了条件が不安定になる。  
根拠: `plan/mailbox-only-poc.ja.md:120`, `plan/mailbox-poc-runtime.example.yaml:96`, `agents/agents.example.yaml:83`, `plan/mailbox-poc-runbook.ja.md:14`  
具体的修正案: `aggregation_result` の consumer を `orchestrator` か `Control Kernel` のどちらかに明示し、`allowed_message_types`/runbook を合わせる。  
代替案: `aggregation_result` を mailbox に流さず、Control Kernel 内部イベントだけで終端確定する。

5. **Medium: `review_result` 側の ACK ルールが明文化不足**  
影響: duplicate 時に `no-op + ack` が assignment では定義済みだが、review_result で再配送ループを起こす余地が残る。  
根拠: `plan/process-manager-boundary.ja.md:43`, `plan/mailbox-poc-runtime.example.yaml:13`, `schemas/poc/process-manager-command.v1.schema.json:281`, `plan/mailbox-poc-runbook.ja.md:36`  
具体的修正案: review_result も「receipt永続化成功時にack」を明文化し、失敗時のみnackへ統一。  
代替案: review_result 用に専用 ack strategy 設定キーを runtime に追加。

6. **Medium: 互換性ポリシーの記述が運用上矛盾**  
影響: 「Minorでoptional追加可」と「v1 strictで未知フィールド追加はmajor」が同居し、運用判断がぶれる。  
根拠: `plan/00-module-boundary-and-interface-contract.ja.md:452`, `plan/00-module-boundary-and-interface-contract.ja.md:462`, `plan/00-module-boundary-and-interface-contract.ja.md:480`  
具体的修正案: PoC v1 期間は「追加はmajor」を明文化し、Minor方針は v2 以降に限定。  
代替案: strict を緩め、拡張用フィールドだけ許可する。

7. **Low: `aggregation-result` 配列制約が緩く、quorum 検証を schema で担保できない**  
影響: `required_agents`/`received_agents` に重複が入っても形式上通るため、ロジック依存が増える。  
根拠: `schemas/poc/aggregation-result.v1.schema.json:15`, `schemas/poc/aggregation-result.v1.schema.json:26`, `plan/mailbox-poc-runtime.example.yaml:71`  
具体的修正案: `uniqueItems: true` と最小件数を PoC 要件に合わせて強化する。  
代替案: schema は現状維持し、aggregator 実装で厳格検証して reject。

## 2. Gate Judgment

**NOT READY**

最小修正チェックリスト（5項目以内）:

1. `ProcessManagerPlan` の TS/Schema を一致（`schema_version` を統一）。  
2. `envelope.task_id` と `payload.task_id` の一致検証を受信ルールに追加。  
3. execution 起動モデルを `push` か `pull` のどちらかに一本化。  
4. `aggregation_result` の消費者と終端遷移責務を1箇所に固定。  
5. review_result の ACK/duplicate ルールを assignment と同等に明文化。  

## 3. Minimal Path（mailbox-first 維持、3〜7ステップ）

1. 契約修正: `process-manager-plan` と `contracts` の型を一致。  
2. 受信バリデーション実装: `sender_id` 正本化 + `task_id` クロスチェック。  
3. 実行モデル固定: `start_execution` と consume/ack の責務を整理。  
4. ルーティング確定: `aggregation_result` の consumer を明示して agents/runtime/runbook を同期。  
5. ACKポリシー統一: assignment/review_result の duplicate 処理を同一パターン化。  
6. E2E追加: `task_id` 不一致、review_result duplicate、aggregation_result 終端遷移の3ケースを固定。  

## 4. Optional Patch（任意）

```diff
diff --git a/contracts/poc/process-manager-boundary.ts b/contracts/poc/process-manager-boundary.ts
@@
 export interface ProcessManagerPlan {
+  schema_version: 1;
   tx_commands: TxCommand[];
   post_commit_commands: PostCommitCommand[];
 }
```

追記文案（`plan/process-manager-boundary.ja.md` など）:

```md
- review_result / aggregation_result 受信時は `envelope.task_id == payload.task_id` を必須検証とする。
- 不一致は署名検証結果に関わらず隔離し、状態遷移入力として採用しない。
```
