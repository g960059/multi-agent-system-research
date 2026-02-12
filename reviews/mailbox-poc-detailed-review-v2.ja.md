# Mailbox-Only PoC 包括設計レビュー（再評価）

作成日: 2026-02-11  
対象リポジトリ: `multi-agent-system-research`

## 1. Findings（重大度順）

1. **Critical: `sender_id` と payload 内 `agent_id` の同一性が未強制（なりすまし余地）**  
影響: `review_result` の送信主体偽装で `quorum=all` 判定を破れる可能性。  
根拠: `schemas/poc/mailbox-envelope.v1.schema.json:19`, `schemas/poc/mailbox-envelope.v1.schema.json:132`, `schemas/poc/review-result.v1.schema.json:15`, `contracts/poc/process-manager-boundary.ts:56`, `plan/mailbox-only-poc.ja.md:106`  
具体的修正案: `review_result` payload から `agent_id` を削除し、主体は envelope `sender_id` のみを正とする。  
代替案: payload `agent_id` を残すなら `payload.agent_id === sender_id` を受信時必須検証。

2. **Critical: orchestrator/aggregator の prompt と `output_schema_ref` が不整合**  
影響: 実行時 schema validation で破綻し、PoC が再現不能。  
根拠: `prompts/reviewer/aggregator.md:7`, `agents/agents.example.yaml:59`, `schemas/poc/aggregation-result.v1.schema.json:5`, `prompts/reviewer/orchestrator.md:7`, `prompts/reviewer/orchestrator.md:8`, `agents/agents.example.yaml:82`  
具体的修正案: aggregator は「payloadのみ出力」か `output_schema_ref` を envelope schema に変更。orchestrator は `process-manager-command` 系 schema へ合わせる。  
代替案: LLM出力（payload）と最終送信（envelope）を runner で2段変換。

3. **High: `visibility_timeout_sec=60` と長時間実行時の ACK 戦略が未定義**  
影響: 処理中に `task_assignment` 再配信が起き、二重実行リスク。  
根拠: `plan/mailbox-poc-runtime.example.yaml:12`, `plan/mailbox-poc-runtime.example.yaml:28`, `plan/mailbox-poc-runtime.example.yaml:29`, `plan/process-manager-boundary.ja.md:42`, `contracts/poc/process-manager-boundary.ts:258`, `plan/mailbox-poc-runbook.ja.md:35`  
具体的修正案: `task_assignment` は「consume直後 receipt 永続化 + ACK」または visibility timeout を hard timeout 超へ固定。  
代替案: assignment は通知専用にして明示 `claim_task` を導入。

4. **High: ACL が `control` / `error` を未定義**  
影響: default allow なら権限漏れ、default deny なら正当メッセージ拒否。  
根拠: `plan/mailbox-poc-runtime.example.yaml:90`, `schemas/poc/mailbox-envelope.v1.schema.json:62`, `schemas/poc/mailbox-envelope.v1.schema.json:63`, `agents/agents.example.yaml:85`, `agents/agents.example.yaml:86`  
具体的修正案: ACL に全 message type を列挙し、未定義拒否（deny-by-default）を明文化。  
代替案: v1 では `control`/`error` を未使用として enum から外す。

5. **Medium: 互換性ポリシー記述が矛盾（Minor追加可 vs strict major扱い）**  
影響: versioning判断が実装者依存になり、N-1互換運用が揺れる。  
根拠: `plan/00-module-boundary-and-interface-contract.ja.md:452`, `plan/00-module-boundary-and-interface-contract.ja.md:462`, `plan/00-module-boundary-and-interface-contract.ja.md:480`  
具体的修正案: v1 strict を優先し「フィールド追加は原則 major」を明記。  
代替案: strict を緩め、拡張許容フィールドを限定導入。

6. **Medium: `completion_notice` が文書と schema/contract で不一致**  
影響: event→command 実装で解釈差分が発生。  
根拠: `plan/process-manager-boundary.ja.md:47`, `contracts/poc/process-manager-boundary.ts:188`, `schemas/poc/process-manager-command.v1.schema.json:64`  
具体的修正案: `completion_notice` を正式追加するか、文書側を既存 type（`aggregation_result`/`control`）へ統一。  
代替案: `TaskCompleted` 通知自体を v1 では外す。

7. **Low: 上位計画の Message Envelope 例が PoC schema とズレる**  
影響: 古い例を参考に実装すると validation 失敗。  
根拠: `plan/multi-agent-platform-plan.ja.md:338`, `plan/multi-agent-platform-plan.ja.md:347`, `schemas/poc/mailbox-envelope.v1.schema.json:21`, `schemas/poc/mailbox-envelope.v1.schema.json:6`  
具体的修正案: 上位計画の例を PoC schema 準拠に更新（`round_id` 削除など）。  
代替案: 「概念例であり PoC schema 非準拠」と注記。

## 2. Gate Judgment

**NOT READY**

最小修正チェックリスト（5項目以内）:

1. `review_result` 主体同一性（`sender_id` と identity）を契約で強制。  
2. aggregator/orchestrator の prompt と `output_schema_ref` を一致。  
3. assignment の ACK 戦略を固定し、visibility timeout と整合。  
4. ACL を全 message type で明示し、未定義拒否ルール追加。  
5. `completion_notice` の扱いを文書・contract・schema で統一。  

## 3. Minimal Path（3〜7ステップ）

1. `review_result` の identity ルールを修正（payload依存を排除）。  
2. `agents/agents.example.yaml` と `prompts/reviewer/*.md` の出力契約を一致。  
3. assignment 受信〜ACK の運用仕様を `runtime` と `runbook` に明文化。  
4. ACL を `task_assignment/review_result/aggregation_result/control/error` で全定義。  
5. `completion_notice` 不整合を解消。  
6. E2E 3本（spoof防止、duplicate assignment、schema mismatch）を固定。  

## 4. Optional Patch（任意）

```md
受信ルール（review_result）:
- payload の `agent_id` は信頼しない。
- 主体は envelope `sender_id` を唯一の真実とする。
- if `sender_id` not in {codex, claude} then reject.
- if payload に `agent_id` を残す場合は `payload.agent_id == sender_id` を必須検証。
```
