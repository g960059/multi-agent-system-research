# Mailbox-Only PoC 詳細設計レビュー

作成日: 2026-02-11  
対象リポジトリ: `multi-agent-system-research`

## 1. レビュー対象

- `plan/00-module-boundary-and-interface-contract.ja.md`
- `plan/multi-agent-platform-plan.ja.md`
- `plan/workflow.example.yaml`
- `plan/mailbox-only-poc.ja.md`
- `plan/mailbox-poc-runtime.example.yaml`
- `plan/mailbox-poc-runbook.ja.md`
- `plan/process-manager-boundary.ja.md`
- `contracts/poc/process-manager-boundary.ts`
- `schemas/poc/mailbox-envelope.v1.schema.json`
- `schemas/poc/review-result.v1.schema.json`
- `schemas/poc/agent-definition.v1.schema.json`
- `schemas/poc/domain-event.v1.schema.json`
- `schemas/poc/process-manager-command.v1.schema.json`
- `agents/agents.example.yaml`
- `prompts/reviewer/codex.md`
- `prompts/reviewer/claude.md`
- `prompts/reviewer/aggregator.md`

## 2. Gate Judgment

- 判定: **NOT READY**
- 理由: 実装に入る前に、契約整合と復旧/認可の境界で破綻しうる Critical/High が残っている。

最小修正チェックリスト（5項目）:

1. Wire契約（TS型とJSON Schema）の命名・必須項目・型を1系統に統一する。
2. `quorum=all` を満たすためのドメイン状態と集約イベントを追加する。
3. 同一Tx更新と外部副作用の実行境界を `tx` / `post_commit` で契約化する。
4. ACL主体（role/agent_id/provider）と署名検証の主キーを一本化する。
5. Aggregator 経路（runtime定義 + payload schema）を完成させる。

## 3. Findings（重大度順）

### F-01 Critical: TS契約とJSON Schemaが相互変換不能

影響:
- バリデーション通過後の型安全を保証できず、正当メッセージ拒否または不正メッセージ受理が発生する。
- 実装者ごとに独自マッピングが発生し、再現性が崩れる。

根拠:
- `contracts/poc/process-manager-boundary.ts:63` は `eventType`（camelCase）
- `schemas/poc/domain-event.v1.schema.json:11` は `event_type`（snake_case）
- `contracts/poc/process-manager-boundary.ts:118` は `commandType`
- `schemas/poc/process-manager-command.v1.schema.json:11` は `command_type`
- `contracts/poc/process-manager-boundary.ts:200` は `msgId`
- `schemas/poc/mailbox-envelope.v1.schema.json:8` は `msg_id`

具体的修正案:
1. wire format を `snake_case` に固定し、SchemaからTS型生成を標準化する。
2. 内部ロジックで `camelCase` を使う場合は mapper を1層に隔離する。
3. CIで「Schema変更時に型再生成必須」をゲート化する。

代替案:
- v1期間だけ dual-read（camel/snake）を受理し、v2で完全統一する。

### F-02 Critical: `quorum=all` を満たせないドメインモデル

影響:
- Codex/Claudeの2結果待機、欠落、重複、再送を決定論で扱えない。
- `manual_review_required` 判定が実装依存になり、結果がぶれる。

根拠:
- `plan/mailbox-only-poc.ja.md:109` で2件待機（`quorum=all`）
- `plan/mailbox-only-poc.ja.md:113` で不一致は `manual_review_required`
- `plan/mailbox-poc-runtime.example.yaml:55` で `required_agents: [codex, claude]`
- `contracts/poc/process-manager-boundary.ts:19` の `TaskAggregate` に reviewer受領集合がない
- `contracts/poc/process-manager-boundary.ts:38` の `record_review_result` は単発記録のみ

具体的修正案:
1. `TaskAggregate` に `requiredReviewerIds` と `receivedReviewResults` を追加する。
2. `DomainEvent` に `ReviewQuorumReached` と `AggregationDecided` を追加する。
3. 冪等キーを `task_id + agent_id + msg_id` で固定し重複を無害化する。

代替案:
- 1 reviewer = 1 task に分割し、Aggregatorを依存タスクとして管理する。

### F-03 Critical: 互換性ポリシーとSchema制約が矛盾

影響:
- 「optional field追加でMinor」の運用が不可能。
- forward compatibility を宣言しているが実態は破壊的変更になる。

根拠:
- `plan/00-module-boundary-and-interface-contract.ja.md:338` は未知フィールド読み飛ばしを要求
- `plan/00-module-boundary-and-interface-contract.ja.md:449` は optional field追加のみ許可
- `schemas/poc/mailbox-envelope.v1.schema.json:6` は `additionalProperties: false`
- `schemas/poc/domain-event.v1.schema.json:6` は `additionalProperties: false`
- `schemas/poc/process-manager-command.v1.schema.json:6` は `additionalProperties: false`

具体的修正案:
1. 方針を一本化する。
2. `additionalProperties: false` を維持するなら「フィールド追加はMajor」を明記する。
3. 互換性要件を維持するなら拡張用namespaced fieldを許可する。

代替案:
- `envelope_ext` / `payload_ext` のみ任意拡張可として本体を凍結する。

### F-04 High: 同一Tx outbox方針に対して副作用境界が未定義

影響:
- commit前に `start_execution` が走ると、rollback後に外部実行だけ残る。
- 再試行で二重実行を生み、監査と整合が崩れる。

根拠:
- `plan/mailbox-only-poc.ja.md:25` は同一Tx確定を要求
- `plan/process-manager-boundary.ja.md:42` は `TaskAssigned -> start_execution`
- `contracts/poc/process-manager-boundary.ts:130` に `start_execution` が存在
- `contracts/poc/process-manager-boundary.ts:170` の `TxPort` は実行フェーズ分離が未定義

具体的修正案:
1. `IntegrationCommand` を `tx_commands` と `post_commit_commands` に分離する。
2. `start_execution` は `post_commit` 専用とし、commit失敗時は実行禁止。
3. `execution_runs` 一意制約で同一タスク二重起動を防ぐ。

代替案:
- execution開始は mailbox consume のみをトリガとし、ProcessManagerから直接起動しない。

### F-05 High: ACL主体の識別子空間が不一致

影響:
- 正常送信がACL違反になるか、逆に誤受理される。
- 署名検証後の「誰として扱うか」が実装ごとに分岐する。

根拠:
- `plan/mailbox-poc-runtime.example.yaml:74` は `task_assignment: [orchestrator]`
- `plan/mailbox-poc-runtime.example.yaml:75` は `review_result: [codex, claude]`
- `schemas/poc/review-result.v1.schema.json:15` は `agent_id` を `codex|claude` に限定
- `agents/agents.example.yaml:16` は `id: codex-reviewer-1`
- `schemas/poc/mailbox-envelope.v1.schema.json:19` は `sender_id` の値域未定義

具体的修正案:
1. ACL主体を `agent_id` か `role` のどちらかに固定する。
2. `sender_id` と `review_result.agent_id` の対応規則を明文化する。
3. 署名鍵管理に `key_id` を追加し `sender_id -> key_id -> principal` を一意化する。

代替案:
- PoC中は `agent_id` 完全一致ACLのみ許可し、role ACLは後段で追加する。

### F-06 High: Aggregator経路が未完成（設定・契約不足）

影響:
- runbook手順どおりの再現ができない。
- `aggregation_result` が自由形式になり、検証不能。

根拠:
- `plan/mailbox-only-poc.ja.md:62` で aggregator worker前提
- `plan/mailbox-poc-runbook.ja.md:14` で aggregator起動手順あり
- `plan/mailbox-poc-runtime.example.yaml:31` 以降に aggregator worker設定がない
- `schemas/poc/mailbox-envelope.v1.schema.json:73` の `payload` が無制約
- `prompts/reviewer/aggregator.md:7` は `aggregation_result envelope` を要求

具体的修正案:
1. runtimeに `workers.aggregator` ブロックを追加する。
2. `schemas/poc/aggregation-result.v1.schema.json` を追加する。
3. `mailbox-envelope` の `payload` を `type` ごとに `oneOf` で制約する。

代替案:
- PoC中は `aggregation_result` を外部message化せず domain event のみに限定する。

### F-07 High: `process-manager-command` schemaが弱すぎて契約として機能しない

影響:
- `command_type` と空 `payload` だけで検証通過し、実行時エラーを量産する。
- commandごとの必須項目を事前に落とせない。

根拠:
- `schemas/poc/process-manager-command.v1.schema.json:23` の `task_id` は任意
- `schemas/poc/process-manager-command.v1.schema.json:34` required は `schema_version|command_type|payload` のみ
- `contracts/poc/process-manager-boundary.ts:116` では commandごとに必要項目が異なる

具体的修正案:
1. `oneOf + discriminator(command_type)` で command別必須項目を定義する。
2. `additionalProperties: false` のまま command固有の shape を確定する。
3. Schema contract testで全commandの最小/境界ケースを追加する。

代替案:
- command schemaを分割（`start-execution-command.v1` 等）し、ルーティング層で束ねる。

### F-08 Medium: 署名仕様の正規化ルールが未定義

影響:
- 同じ内容でも署名検証結果が実装ごとに変わる。
- replay防止が `nonce` 保存実装に依存し、監査不能になる。

根拠:
- `plan/00-module-boundary-and-interface-contract.ja.md:433` は署名必須のみ
- `plan/00-module-boundary-and-interface-contract.ja.md:442` は nonce/issued_at を要求
- `plan/mailbox-poc-runtime.example.yaml:70` は `ed25519` 指定のみ
- `schemas/poc/mailbox-envelope.v1.schema.json:35` は `signature` 文字列制約のみ

具体的修正案:
1. 署名対象フィールド順序・canonical JSON仕様を確定する。
2. `key_id` と鍵ローテーション手順を定義する。
3. nonce保管の主キー・TTL・衝突時挙動をDB制約として定義する。

代替案:
- PoCではHMAC固定の単純仕様に限定し、ed25519は次フェーズで導入する。

### F-09 Medium: 重複排除の永続化手段が契約に反映されていない

影響:
- relay再送時に状態遷移二重適用の危険が残る。

根拠:
- `plan/mailbox-only-poc.ja.md:102` は `msg_id` 重複排除を要求
- `plan/mailbox-only-poc.ja.md:128` は `state store` テーブル例を列挙
- `plan/mailbox-poc-runbook.ja.md:34` は duplicate delivery を検証対象にしている
- `contracts/poc/process-manager-boundary.ts:195` の ack/nack だけでは重複受信判定が保存されない

具体的修正案:
1. `message_receipts(agent_id, msg_id)` の一意制約を追加する。
2. domain適用前に receipt insert を同一Txで行う。
3. duplicate時は no-op + ack の標準動作を固定する。

代替案:
- domain command全体を冪等キー化し、receipt導入を次段へ先送りする。

### F-10 Low: 代表例のmessage typeが現行enumと不一致

影響:
- 設計書を参照した実装者が `task_result` を送って弾かれる。

根拠:
- `plan/multi-agent-platform-plan.ja.md:345` は `type: task_result`
- `schemas/poc/mailbox-envelope.v1.schema.json:49` enumに `task_result` がない

具体的修正案:
1. 代表例を `review_result` に更新する。
2. もし互換受理するなら `task_result` の廃止期限を明記する。

代替案:
- 受理時に `task_result -> review_result` を正規化する adapter を置く。

## 4. Minimal Path（方針維持の最短実装）

1. `schemas/poc/*.json` を canonical wire contract として確定し、TS型を再生成する。
2. `TaskAggregate` を quorum対応に拡張し、`ReviewQuorumReached` を追加する。
3. Control Kernelを `tx` と `post_commit` 実行に分離する。
4. `message_receipts` と `nonces` の永続制約を migrationで導入する。
5. aggregator worker設定と `aggregation-result` schemaを追加する。
6. E2Eを3本固定（正常系、relay復旧、署名/nonce/ACL異常系）。

## 5. Optional Patch（追記案）

以下を `plan/process-manager-boundary.ja.md` に追記すると、実装境界の曖昧さを減らせる。

```md
## 8. Tx / Post-Commit 実行規約

- ProcessManager が返す IntegrationCommand は2種類に分類する。
  - tx_commands: state/event/outbox のみ（DBトランザクション内）
  - post_commit_commands: execution開始、mailbox ack/nack などの外部I/O
- Control Kernel は tx_commands を単一Txで確定し、commit成功時のみ post_commit_commands を実行する。
- rollback時は post_commit_commands を実行してはならない。
- post_commit_commands は冪等実行を前提とし、`execution_runs` と `message_receipts` の一意制約で二重実行を防ぐ。
```

## 6. レビュー結論

Mailbox-only PoC 方針自体は妥当で、スコープ選択も現実的。  
ただし、現時点は「実装してから調整」ではなく、契約の最小修正を先に終える方が手戻りコストが小さい。
