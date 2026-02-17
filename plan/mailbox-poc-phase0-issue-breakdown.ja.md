# Mailbox PoC Phase 0 実行計画（Issue分解）

対象期間: 2026-02-12 〜 2026-02-26  
親計画: `plan/mailbox-poc-roadmap-next.ja.md`

## 1. 目的

Phase 0 のゴールである「契約固定と回帰防止」を、実行可能なIssue単位に分解する。

## 2. Issue一覧

| Issue ID | タイトル | 目的 | 主な変更対象 | 完了条件（DoD） | 依存 |
|---|---|---|---|---|---|
| P0-01 | Schema Versioning Policy 文書化 | `v1`改変と`v2`移行基準を明確化 | `docs/contracts/schema-versioning-policy.ja.md`（新規） | 破壊変更の定義、移行手順、互換期間、in-flight taskのversion negotiation方針が明記されレビュー合意済み | なし |
| P0-02 | `agents:validate` 雛形追加 | 設定不整合を起動前に検知 | `package.json`, `src/poc/modules/agent-definition-policy.ts`, 新規validator script | `agents.yaml`検証コマンドが追加され、unknown profile/role/providerを失敗扱いにできる。unit+integrationテストを追加 | P0-01 |
| P0-03 | CI最小ゲート追加 | 回帰を常時検出 | CI workflow, `package.json` scripts | PRで `build`, `poc:e2e`, `skill:test:mailbox-parallel-review` が必須 | なし |
| P0-04 | Runbook更新（summary/full_diff運用） | レビュー運用の再現性を上げる | `plan/mailbox-poc-runbook.ja.md`, skill docs | いつ`summary_only`/`full_diff`を使うか判断基準が明文化 | なし |
| P0-05 | Policy解決結果のsnapshot test | `provider x role`の暗黙変更を検知 | `src/poc/e2e.ts` または dedicated test file | policy解決結果の差分がテストで検出される | P0-01, P0-02 |
| P0-06 | fail-close固定テスト追加 | fail-open回帰を防止 | `src/poc/e2e.ts`, `src/poc/modules/*` | review payload/env_profile/arg precedence を壊す変更が失敗する。異常系統合テストを追加 | P0-02, P0-03 |
| P0-07 | 脅威マトリクス v0 作成 | セキュリティ試験の網羅基準を固定 | `docs/` または `plan/` の脅威文書、`src/poc/e2e.ts` | 攻撃面/防御/テストの対応表が作成され、Phase 1拡張との差分が定義される | P0-06 |
| P0-08 | MTTDベースライン計測 | Phase 4目標の比較基準を固定 | `plan/mailbox-poc-runbook.ja.md`, 計測ログ | メトリクス基盤未導入期間の手動演習手順を定義し、診断時間を採取してp95算出方法を文書化 | P0-03 |
| P0-09 | Phase 0 完了レビュー | Exit Criteria達成確認 | `reviews/` または計画更新 | Exit Criteria 6項目の達成根拠を記録し、証跡リンクを残す | P0-03, P0-04, P0-05, P0-06, P0-07, P0-08 |

## 3. 推奨実行順

1. P0-01（契約ルールを先に固定）
2. P0-03（CIゲートで基盤を固める）
3. P0-02（設定検証を追加）
4. P0-06（fail-close異常系を固定）
5. P0-04（運用手順を更新）
6. P0-05（契約差分検知の自動化）
7. P0-07（脅威基準の固定）
8. P0-08（運用計測の基準化）
9. P0-09（完了判定）

## 4. 2週間スプリント案

### Sprint Week 1

1. P0-01 着手・レビュー完了
2. P0-03 実装・PRゲート化
3. P0-02 雛形実装（最低限）
4. P0-06 異常系テストの雛形追加

### Sprint Week 2

1. P0-02 強化（エラーメッセージ、CLI引数）
2. P0-04 runbook反映
3. P0-05 snapshot test導入
4. P0-06 異常系テストの拡張（spoof/profile typo/arg precedence）
5. P0-07 脅威マトリクス v0 作成とレビュー
6. P0-08 MTTDベースライン計測と記録
7. P0-09 達成確認と次Phase受け入れ判定

## 5. リスクと対策

1. リスク: `v1`運用ルール未確定のまま実装が進み、仕様が揺れる  
対策: P0-01を最優先にし、未合意の契約変更は保留する。

2. リスク: CIゲート追加で一時的に開発速度が落ちる  
対策: 最小3ジョブに限定して開始し、段階的に拡張する。

3. リスク: validatorとruntimeの判定差異  
対策: validatorは`agent-definition-policy`を再利用し、ロジック重複を避ける。

4. リスク: Phase 0 の期間見積もりが楽観的で、完了判定が形式化だけになる  
対策: Week 1 末に中間レビューを設定し、未達Issueが2件以上なら翌週でスコープ調整する。

## 6. テスト戦略（Issue別）

| Issue ID | 必須テスト層 | 検証コマンド/証跡 |
|---|---|---|
| P0-01 | 文書レビュー | PRレビュー記録、`docs/contracts/schema-versioning-policy.ja.md` へのリンク |
| P0-02 | unit + integration | `npm run poc:e2e`（validator連携ケース） |
| P0-03 | CI workflow | PR checks（`build`/`poc:e2e`/`skill:test:mailbox-parallel-review`） |
| P0-04 | runbook dry-run | runbook手順に沿った1回の再現ログ |
| P0-05 | snapshot | snapshot差分がCIで検知されるログ |
| P0-06 | integration + e2e 異常系 | fail-close異常系ケースのPASSログ |
| P0-07 | 脅威分析 + integration | 脅威マトリクス文書、対応テスト一覧 |
| P0-08 | 運用演習計測 | 障害演習ログ、MTTD算出記録 |
| P0-09 | 受け入れ判定 | Exit Criteriaの証跡一覧（リンク付き） |

## 7. Exit Criteria チェックリスト

1. 契約破壊を伴う変更がCIで検知される。
2. `build/poc:e2e/skill:test` が required check として有効で、直近10実行IDと結果が証跡化されている。
3. reviewer失敗分類（auth/network/execution）が失敗ケースの100%で出力される。
4. Phase 1 セキュリティ最小実装の受け入れ基準がレビュー合意されている。
5. 最小セキュリティ制御（allowlist/profile参照検証）が実行パスで有効化され、spoof異常系テストがCIでPASSする。
6. 脅威マトリクス v0 がレビュー合意され、Phase 1拡張対象との差分が明確化されている。
