# Mailbox PoC 後続ロードマップ（長期フェーズ版 / 2026-02-12更新）

対象: `multi-agent-system-research`  
計画期間: 2026-02-12 〜 2026-08-07（約6か月）

関連文書:

1. Phase 0 Issue分解: `plan/mailbox-poc-phase0-issue-breakdown.ja.md`
2. 現行構成マップ: `docs/codebase-map.ja.md`

## 0. 現在地（2026-02-12時点）

完了済み:

1. mailbox-first PoC の最小実行系は稼働（並列レビュー -> 集約 -> 最終判定）。
2. 主要防御（ACL / signature / task_id一致 / duplicate no-op+ack）を実装。
3. agent抽象化の第一段として、reviewer profile を動的化。
4. `agent-definition-policy` を導入し、`provider x role` ベースの自動補完を開始。
5. `mailbox-parallel-review` skill と mailbox統合テストを導入。
6. fail-open修正として、review payload正規化を fail-close 化。

未完了の主要課題:

1. `agents.yaml` を唯一の正本にする運用（YAML/JSON併存の解消）。
2. runtime内責務の分離完了（TaskDomain / ProcessManager / Adapter境界）。
3. durable state store（SQLite）への移行。
4. 運用観測（メトリクス・再実行性・監査）とスケール最適化。

## 1. 全体方針

1. fail-close をデフォルトにする（不明値は通さない）。
2. 設定の正本は1つにする（生成物は派生扱い）。
3. policy解決と実行を必ず結線する（宣言だけで終わらせない）。
4. 「機能追加」より「境界固定」を優先する。
5. workflow module は Gate 条件達成後に着手する。
6. 設定サーフェス拡張と同時に最小セキュリティ制御を前倒し実装する。

## 2. フェーズ計画

### 2.0 フェーズ依存マトリクス

| フェーズ | 依存 | 並行着手可否 | 着手条件 |
|---|---|---|---|
| Phase 0 | なし | なし | 即時着手 |
| Phase 1 | Phase 0 | 一部可 | Phase 0 Exit Criteria達成 |
| Phase 2 | Phase 1 | 一部可 | policy解決とruntime結線が安定 |
| Phase 3 | Phase 2 | 設計のみ可 | Domain/Adapter境界の固定完了 |
| Phase 4 | Phase 3 | 一部可 | durable state store稼働 |
| Phase 5 | Phase 1,4 | 可 | 基礎観測と定義プラットフォームが安定 |
| Phase 6 | Phase 3,4,5 | 可 | 安全性と観測の基礎要件達成 |

補足:

1. Phase 3 は、Phase 2 完了前に「移行設計」と「検証シナリオ定義」のみ先行可能。
2. Phase 1 の「一部可」は文書整備・検証ケース定義のみを指し、runtime挙動変更は Phase 0 Exit 達成後に限定する。
3. Phase 4/5/6 は実装並行できるが、Phase 3 Exit 前は「interface追加/変更」を禁止し、観測・運用整備に限定する。
4. Go/No-Go Gate 判定では Phase 3 完了を必須とする。
5. Phase 3 開始前に、最小観測セット（structured logs + divergence/retry/deadletterカウンタ）を有効化する。

### Phase 0: 契約固定と回帰防止（2026-02-12 〜 2026-02-26）

目的: いまの設計改善を壊さない土台を先に固める。

主タスク:

1. schema versioning方針を明文化（`v1`改変許容範囲、破壊変更時の`v2`条件）。
2. fail-close要件をテストで固定（review payload / env_profile参照 / arg precedence）。
3. CIで`build + poc:e2e + skill:test`を最小ゲート化。
4. `summary_only`レビューと`full_diff`レビューの使い分け運用をrunbookに反映。
5. 最小セキュリティ制御（provider別allowlist、profile参照検証、spoof試験）を Phase 0 で先行実装し、Phase 1で拡張する。
6. 脅威マトリクス v0（攻撃面、期待防御、テスト対応）を作成し、Phase 1拡張の基準にする。
7. MTTD計測の初期ベースラインを手動障害演習で採取し、計測開始/終了トリガーとp95算出方法を定義する。

Exit Criteria:

1. 契約破壊を伴う変更がCIで検知される（schema/policy snapshotを含む）。schema方針は `docs/contracts/schema-versioning-policy.ja.md` に集約する。
2. `build/poc:e2e/skill:test` が required check として有効で、Phase 0 完了時に直近10実行IDと結果を証跡として固定できる。
3. 失敗時の分類（auth/network/execution）が失敗ケースの100%で出力される。
4. Phase 1 セキュリティ最小実装の受け入れ基準が文書化され、レビュー合意済み。
5. 最小セキュリティ制御（allowlist/profile参照検証）が実行パスで有効化され、spoof異常系テストがCIでPASSする。
6. 脅威マトリクス v0 がレビュー合意され、Phase 1拡張対象との差分が明確化されている。

### Phase 1: Agent定義プラットフォーム化（2026-02-27 〜 2026-03-20）

目的: DX改善。`agents.yaml`作成体験を簡潔にしつつ安全性を維持する。

主タスク:

1. `agents.yaml` を唯一入力に固定し、`resolved`を生成する compile ステップを実装。
2. `provider x role` policy table を明示化（コマンド・メッセージ型・env profile）。
3. overrideのルールを制限（allowlist型、禁止キー、衝突時優先順位）。
4. author向け lint/validate コマンドを追加（例: `npm run agents:validate`）。
5. Phase 0 最小実装を policy table / compile step / override制御に統合し、例外運用を標準化。
6. adversarial tests（spoof/malformed/profile typo）を脅威マトリクス化して拡張。
7. 既存JSONサンプル（`plan/*.example.json`）を `agents.yaml` 由来の生成物へ移行し、非推奨化を明記。

Exit Criteria:

1. 手書きのJSON例への依存がなくなる。
2. `agents.yaml`単体で runtime 起動が再現可能。
3. policy解決結果に対する snapshot テストが導入済み。
4. unknown env/command/profile が fail-close で拒否されることをE2Eで確認済み。
5. 脅威マトリクスと adversarial tests が対応付けられ、coverage欠落が可視化されている。
6. JSONサンプルの手動更新運用が廃止され、生成フローまたは非推奨マークへ統一される。

### Phase 2: Runtime境界分離完了（2026-03-23 〜 2026-04-17）

目的: 長期保守のために責務境界をコードで固定する。

主タスク:

1. `TaskDomain`（純粋関数）を追加し、状態遷移判定を集約。
2. `ProcessManager` を追加し、`DomainEvent -> IntegrationCommand`を集中管理。
3. `ExecutionAdapter` / `MailboxTransport` / `StateStore` をinterface化。
4. `runtime.ts` は orchestration の薄い組み立て層へ縮小。
5. Phase 3 で使う dual-write/shadow-read 比較仕様（等価判定、順序/重複/timestamp許容、除外対象）を先行確定する。
6. Phase 3 開始条件となる最小観測セット（structured logs + divergence/retry/deadletterカウンタ）を実装し、計測runbookを用意する。

Exit Criteria:

1. Domain層はI/O依存ゼロ。
2. Adapter差し替えテスト（mock adapter）が通る。
3. `runtime.ts` の変更が policy/domain変更と分離してレビュー可能。
4. dual-write/shadow-read 比較仕様が文書化され、比較ツールの dry-run がPASSする。
5. Phase 3 開始に必要な最小観測セットが有効化され、ダミー障害演習で値が採取できる。

### Phase 3: Durable State Store移行（2026-04-20 〜 2026-05-15）

目的: ファイルPoCから復旧可能な永続実装へ。

開始条件:

1. Phase 2 で定義した比較仕様が凍結済み。
2. 最小観測セット（structured logs + divergence/retry/deadletterカウンタ）が有効化済み。

主タスク:

1. SQLite実装（tasks/events/outbox/message_receipts/nonces/quarantine）を追加。
2. dual-write（file+SQLite）期間を設け、書き込み整合を比較する。
3. shadow-read（SQLite優先読み取りの影運転）期間を設け、復元結果差分を監視する。
4. outbox relay をSQLite駆動へ置換（cutover gate通過後）。
5. crash/restart耐性テストと再送整合テストを自動化。
6. backfill/reconciliation/rollback手順をrunbook化し、fail条件を定義する。
7. deadletter/quarantine の監査クエリをrunbook化。
8. Phase 2 で凍結した比較仕様を比較ツールへ適用し、cutover判定の唯一基準として使う。

Exit Criteria:

1. `state transition + event + outbox` が同一Txで保証される。
2. dual-write判定は `dual_write_report.jsonl` を唯一ソースとし、対象母集団は dual-write対象の正常タスクとする。差分1件で連続カウントをリセットし、`連続7日` または `連続1000タスク` のいずれか達成で合格。
3. shadow-read判定は `shadow_read_report.jsonl` を唯一ソースとし、対象母集団は再実行可能な正常タスクとする。差分1件で連続カウントをリセットし、`連続100タスク` 達成で合格。
4. cutover後 crash再起動で通知欠落ゼロ、重複はidempotencyで吸収可能。
5. rollback手順の演習を実施し、30分以内に復旧できる。
6. 監査ログからtask単位で履歴追跡できる。
7. 比較ツールで dual-write/shadow-read の差分判定が機械的に再現できる（同一入力で同一結果）。

### Phase 4: 運用観測とSRE基盤（2026-05-18 〜 2026-06-12）

目的: 障害時の原因切り分けを短時間化する。

主タスク:

1. 構造化ログ（task_id/msg_id/agent_id/pass）を標準化。
2. メトリクス拡張（queue depth, processing latency, deadletter rate, MTTD, phase別SLO可視化）。
3. 再実行コマンドと運用フローをskill/runbookに統合。
4. エラー分類ごとの自動アクション（retry/backoff/manual gate）を整理。

Exit Criteria:

1. 障害時の診断時間（MTTD）が p95 10分以内（20件の障害演習で計測）。
2. 主要運用ケース（再実行/隔離解除/手動集約）がrunbookのみで再現可能。
3. deadletter率、retry率、queue depth がダッシュボードで追跡可能。

### Phase 5: 高度セキュリティ強化（2026-06-15 〜 2026-07-10）

目的: Phase 1 で導入した基礎防御を、運用監査・鍵管理・攻撃耐性の観点で強化する。

主タスク:

1. Phase 1 allowlist の厳格化（deny-by-default監査、drift検知、例外申請フロー）を実装。
2. 署名鍵運用（key_idローテーション戦略、ロールオーバー手順、失効時対応）を明文化。
3. adversarial tests を脅威マトリクス化し、route violation/権限昇格/再送攻撃を追加。
4. セキュリティ監査ログ（設定変更・拒否イベント・鍵イベント）を標準化。

Exit Criteria:

1. 主要脅威シナリオが脅威マトリクスと1対1で自動テスト化される。
2. 基礎防御（Phase 1）との差分強化項目が監査証跡で追跡できる。
3. 鍵ローテーション演習で失効/切替が無停止で完了する。

### Phase 6: スケール最適化（2026-07-13 〜 2026-08-07）

目的: 並列タスク増加時のスループットと安定性を上げる。

主タスク:

1. reviewer実行の並列化戦略（プロセス/キュー）を導入。
2. 同期I/Oホットパスの非同期化またはバッチ化。
3. state書き込み最適化（append-first、集約書き戻し削減）。
4. ベンチマーク基準を策定（タスク数xレビューア数x平均遅延）。

Exit Criteria:

1. 目標SLO（例: 50 task/hでエラー率 < 1%）を満たす。
2. 運用コスト（手動復旧時間）がPhase 0比で有意に低下。

## 3. Go/No-Go Gate（workflow module着手条件）

次の4条件を満たすまで workflow module に進まない。

1. Phase 0〜3 の Exit Criteria 達成（durable store cutover完了を含む）。
2. 運用観測（Phase 4の最小セット）で、MTTD p95 10分以内を満たす。
3. agent定義の正本運用（Phase 1）が定着し、基礎セキュリティ制御（allowlist/profile参照検証）が本線運用に反映済み。
4. 手動復旧演習を「直近30日で当該実装にコミットしていない運用担当」がrunbookのみで完走できる。

## 4. 直近2週間の実行バックログ（2026-02-12 〜 2026-02-26）

優先順:

1. schema versioning ルール文書を追加。
2. `agents:validate` の雛形追加（policy解決+参照整合チェック）。
3. CIに `build/poc:e2e/skill:test` の最低ゲートを追加。
4. runbookへ`summary_only`と`full_diff`の使い分けを追記。
5. 破壊変更検知のsnapshotテスト（agent policy解決結果）を追加。
6. fail-close固定テスト（review payload/env_profile/arg precedence）を独立Issueとして追加。
7. Phase 1 先行分の adversarial smoke tests（spoof/malformed/profile typo）を追加。
8. MTTDベースライン計測手順を追加し、Phase 4の評価軸を固定する。

## 5. フェーズ失敗時プロトコル

1. Exit Criteria 未達の場合、次フェーズへ進まず、未達項目ごとに blocking issue を起票する。
2. cutover系変更（Phase 3）は rollback 手順の演習完了まで本番相当運用に進めない。
3. 重大未達（データ欠落、fail-open、診断不能）が発生した場合、直近フェーズのマージを凍結し、原因分析完了まで新規機能追加を停止する。
4. 48時間以内に再計画（スコープ縮小/期間延長/追加ガード）を更新し、ロードマップへ反映する。

## 6. 今はやらないこと

1. 動的team編成（workflow module前提）。
2. service stage の高度制御。
3. hooks adapter本実装。
4. 分散実行最適化（Phase 6の後段で検討）。
