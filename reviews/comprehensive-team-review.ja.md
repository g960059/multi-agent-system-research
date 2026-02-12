# マルチエージェント基盤 包括的チームレビュー

作成日: 2026-02-11
レビュー対象:
- `docs/mailbox-orchestration-design-summary.ja.md`
- `plan/00-module-boundary-and-interface-contract.ja.md`
- `plan/multi-agent-platform-plan.ja.md`
- `plan/workflow.example.yaml`

---

## 1. レビューチーム構成

| エージェント | 役割 | 観点 |
|-------------|------|------|
| Opus-1 | シニアアーキテクト | 必要性・スコープ検証 |
| Opus-2 | 分散システム専門家 | アーキテクチャ・モジュール境界 |
| Opus-3 | TypeScript/DX専門家 | 実装者視点・開発体験 |
| Opus-4 | PM兼テックリード | リスク・実現可能性 |
| Research | 調査担当 | 競合・代替ソリューション |

---

## 2. 評価サマリー

### 2.1 各エージェントの結論

| エージェント | 結論 | スタンス |
|-------------|------|----------|
| **必要性・スコープ** | 現時点で構築すべきではない | 批判的 |
| **アーキテクチャ** | 実装可能な品質。問題点を解決すれば進行可 | 肯定的（条件付き） |
| **DX・実装者視点** | 設計は良いが実装ガイドが不足 | 肯定的（条件付き） |
| **リスク・実現可能性** | 2週間でプロトタイプを先に作れ | 警告的 |
| **競合・代替調査** | 今回の設計は必要 | 肯定的 |

### 2.2 総合評価

**設計の方向性は正しいが、スコープが過大でプロトタイプによる検証が必要。**

---

## 3. 一致した見解

### 3.1 方向性は正しい

以下の設計原則は全エージェントが支持:

- Contract-First（契約先行）アプローチ
- 疎結合なモジュール設計
- 非LLM orchestrator による決定論的制御
- mailbox + tmux + state store の責務分離

### 3.2 スコープが過大

- 7モジュール・Event Sourcing・Reservation は初期には過剰
- 計画書で「MVP」と呼んでいるものは実際には「Version 1.0」相当
- Phase 1 だけで 1-2ヶ月かかる可能性がある

### 3.3 検証が不足

- 解決すべき問題の定量データがない
  - ファイル衝突は週に何回発生しているか？
  - 手動復旧に月何時間かけているか？
  - compact乖離でどれだけの手戻りが発生しているか？
- 既存ツール（Agent Teams, TAKT等）の検証が不十分
- 動くプロトタイプなしに契約を固めるのはリスク

### 3.4 ドキュメントのギャップ

「なぜそう設計したか」はあるが「どう実装するか」がない:

| カテゴリ | 現状 | 必要なもの |
|---------|------|-----------|
| クイックスタート | なし | 10分で動かせるチュートリアル |
| DSLリファレンス | 例のみ | 全フィールドの説明 + JSON Schema |
| APIリファレンス | 型定義のみ | 各メソッドの詳細説明 |
| エラーコード一覧 | 一部のみ | 全エラーコード + 対処法 |
| 状態遷移図 | なし | task/reservation/workflowの状態図 |
| CLI仕様 | なし | コマンドリファレンス |

---

## 4. 対立する見解

| 論点 | 批判派 | 肯定派 |
|------|--------|--------|
| **既存ツールで代替可能か** | Git worktree + シェルスクリプトで十分 | 既存ソリューションは部分的。独自実装が必要 |
| **Event Sourcing** | 不要。CRUD + audit log で十分 | 監査性と復旧に有効（ただし難度高） |
| **Reservation Module** | 不要。Git worktree で解決 | ファイル競合制御に必要 |
| **構築すべきか** | 100行スクリプトで仮説検証すべき | 既存ツールでは問題が部分的にしか解決できない |

---

## 5. 詳細レビュー: 必要性・スコープ検証

### 5.1 問題の検証が不十分

ドキュメントでは以下の問題を挙げているが、定量データがない:

- 会話コンテキストの肥大化
- compact時の文脈乖離
- ファイル編集の衝突
- レビューNGの手戻り
- エージェント停止時の復旧

**推測**: おそらくまだ2-3台程度のエージェントを試験運用している段階。その規模で7モジュール・500行超の計画書は過剰。

### 5.2 既存ツールの検証不足

| ツール | 言及 | 検証状況 |
|--------|------|----------|
| Claude Code Agent Teams | 参考実装として言及 | なぜ使わないのか説明なし |
| TAKT | 設計参照のみ | 不採用理由が不明確 |
| Git worktree | 言及なし | ファイル競合の代替策として未検討 |

### 5.3 ROI試算

仮に月100万円の開発者が4ヶ月従事 = 400万円

この投資を回収するには:
- 月10万円相当の工数削減で3.3年
- 月50万円相当で8ヶ月

現時点でマルチエージェント運用にかかっている手作業コストは？

### 5.4 最小限の解決策

```
/mailbox/
  inbox-coder.jsonl
  inbox-reviewer.jsonl

/state/
  tasks.json

run.sh (orchestratorスクリプト)
```

100行以下のシェルスクリプトで検証可能。

---

## 6. 詳細レビュー: アーキテクチャ・モジュール境界

### 6.1 強み

1. Contract-First アプローチの徹底
2. 単一責務に基づくモジュール分割
3. Event Sourcing の採用による監査性
4. 開発ルール（Rule-01 〜 Rule-06）の明文化

### 6.2 技術的問題点

| 優先度 | 問題 | 対応 |
|--------|------|------|
| High | Runtime -> Mailbox 依存が未定義 | 依存ルールに追加 |
| High | MVP例外の Dual Write 問題 | 設計見直し |
| High | Worker の責務定義が不明確 | モジュール追加または明確化 |
| Medium | Query インターフェースの不足 | GetTask, ListTasks 等を追加 |
| Medium | Heartbeat と Lease の関係が曖昧 | ドキュメント追記 |
| Medium | State Store スケーラビリティ | 移行パスの計画 |
| Low | Reservation の効率的競合検出 | 実装時に検討 |
| Low | Graceful Shutdown 手順が未定義 | 運用ドキュメント追加 |

### 6.3 依存関係の問題

#### Task -> Mailbox 依存の意図が不明

依存ルールに `Task -> Mailbox` があるが、Task モジュールがなぜ直接 Mailbox を呼ぶのか説明がない。

**提案**: イベント経由（`TaskCompleted` イベント → Mailbox が subscribe）のほうが疎結合。

#### Runtime と Mailbox の依存が未定義

`Flow-01 通常実行` の補足に「Runtime/Worker が mailbox 配送を担当」とあるが、依存ルールに記載されていない。

---

## 7. 詳細レビュー: DX・実装者視点

### 7.1 TypeScript インターフェースの問題

```ts
// 現状: 入力・出力の型が未定義
export interface TaskModule {
  claimTask(input: ClaimTaskCommand): Promise<ClaimTaskResult | null>;
}
```

`ClaimTaskCommand` や `ClaimTaskResult` の定義がない。

**提案**: 完全な型定義を追加

```ts
export interface ClaimTaskCommand {
  workerId: string;
  capabilities: string[];
  filters?: { stage?: string; priority?: number };
  requestId: string;
}

export interface ClaimTaskResult {
  task: {
    taskId: string;
    leaseUntil: Date;
  };
  status: 'claimed';
}

export type ClaimTaskError = 'NO_TASK' | 'CONFLICT' | 'INVALID_FILTER';
```

### 7.2 workflow.yaml DSL の問題

`strategy: service` の意味が YAML 単体で理解できない。

**提案**: JSON Schema とコメント付きテンプレートを追加

```yaml
# strategy:
#   - parallel: すべてのagentsが並列実行
#   - single: 1つのagentのみ実行
#   - service: 別stageと並行して常駐（starts_with必須）
strategy: service
```

### 7.3 gate 定義の式が曖昧

```yaml
pass_when: "blocking_count == 0"
```

これは JavaScript 式か？独自 DSL か？

**提案**: 式言語を明確化

```yaml
# Option A: 明示的にJavaScript
pass_when:
  engine: javascript
  expr: "blocking_count == 0"

# Option B: 構造化
pass_when:
  field: blocking_count
  operator: eq
  value: 0
```

### 7.4 不足している CLI 仕様

```bash
# 欲しいコマンド例
agent-cli workflow run <workflow.yaml>
agent-cli workflow status <workflow_id>
agent-cli task list [--status=queued|running|...]
agent-cli task claim --worker-id=<id> --capabilities=backend,ts
agent-cli mailbox read <agent_id> [--limit=10]
agent-cli reservation acquire --owner=<agent> --paths="src/**" --mode=exclusive
agent-cli event-log query --correlation-id=<id>
```

---

## 8. 詳細レビュー: リスク・実現可能性

### 8.1 技術的リスク

| リスク | 詳細 | 影響度 |
|--------|------|--------|
| Event Sourcing の実装難度 | projection 整合性、リプレイ性能、スナップショット戦略が未定義 | 高 |
| Lease/Heartbeat の分散システム問題 | clock skew、network partition時の挙動が曖昧 | 高 |
| Workflow DSL の表現力と実行エンジン乖離 | `strategy: service` の実装が複雑 | 高 |
| File Reservation の glob 評価 | glob-to-glob 比較は実装コストが高い | 中 |
| mailbox atomicity | NFS では atomic rename が保証されない | 中 |

### 8.2 実装工数見積

| チーム規模 | Phase 1 完了まで | Phase 3 完了まで |
|------------|------------------|------------------|
| 1人（フルタイム） | 2-3ヶ月 | 6-9ヶ月 |
| 2人（フルタイム） | 1-2ヶ月 | 3-5ヶ月 |

### 8.3 隠れた前提条件

1. LLM エージェントの実装は別途存在する前提
2. tmux 環境への依存（セッション管理の詳細が未定義）
3. SQLite の同時アクセス制限（WAL モードでも write lock 競合）
4. CLI 環境（Codex/Claude）の仕様差異

### 8.4 欠落しているフォールバック

1. State Store 破損/喪失時の backup/restore 戦略
2. Workflow 定義の循環依存検出
3. Reservation デッドロック対応
4. システム全体のロールバック手順

---

## 9. 詳細レビュー: 競合・代替ソリューション

### 9.1 主要ツール評価

| ツール | 主要機能 | 制限 | 推奨 |
|--------|----------|------|------|
| TAKT | YAML workflow, Faceted Prompting, CI/CD mode | 通信/lease管理は別設計が必要 | 参考 |
| Claude Agent Teams | チームリード方式, 共有タスク, Hooks連携 | セッション再開不可, ファイルロックなし | 参考 |
| OpenAI Agents SDK | ハンドオフ, ガードレール, トレーシング | メモリなし, 複雑なグラフに不向き | 参考 |
| LangGraph | DAGベース, 条件分岐, サイクル可能 | 学習曲線急, デバッグ複雑 | 参考 |
| CrewAI | ロールベースチーム, メモリ管理 | 本番移行課題, 未解決バグ | 参考 |
| Temporal | 耐久性実行, OpenAI統合 | インフラオーバーヘッド | 参考 |
| Git Worktree | ファイル競合の根本回避 | - | **採用** |

### 9.2 今回の設計との比較

| ソリューション | context管理 | 通信信頼性 | タスク競合 | ファイル競合 | 障害復旧 |
|---------------|------------|-----------|-----------|-------------|---------|
| TAKT | - | - | - | - | - |
| Claude Agent Teams | △ | △ | △ | × | × |
| LangGraph | ○ | ○ | ○ | - | ○ |
| **今回の設計** | ○ | ○ | ○ | ○ | ○ |

凡例: ○=対応済み、△=部分対応、×=非対応、-=対象外

### 9.3 結論

**今回の設計は必要**。理由:

1. 既存ソリューションはいずれも部分的
2. Claude Code 特化の要件がある
3. ファイル競合制御の欠如（ほとんどのフレームワークが無視）
4. 非LLM orchestrator の重要性

---

## 10. 推奨アクション

### 10.1 即座に行うべき

| # | アクション | 理由 |
|---|-----------|------|
| 1 | **2週間でプロトタイプを作る** | 動くものを見てから計画を再評価 |
| 2 | **真のMVPを再定義** | coder 1 + reviewer 1 で claim → 実装 → review → done |
| 3 | **Event Sourcing を外す** | CRUD + audit log で開始 |
| 4 | **Reservation を外す** | Git worktree で代替 |

### 10.2 プロトタイプに含めるもの

```
最小構成:
├── workflow.yaml（depends_on のみ、gates は後回し）
├── tasks.json（queued/claimed/done/failed の4状態）
├── mailbox/（単純なJSONLファイルキュー）
├── state.db（SQLite単純テーブル）
└── run.sh（orchestrator）
```

### 10.3 プロトタイプから除外

- Event Sourcing / Projection
- Reservation / touched_paths
- Runtime Supervisor（手動で worker 起動/停止）
- Gateway / Hooks Adapter
- Schema Versioning
- 動的チーム招集/解散

### 10.4 既存ツールの活用方針

| ツール | 推奨 | 活用方法 |
|--------|------|----------|
| **Git Worktree** | **採用** | ファイル競合回避の第一選択 |
| **TAKT** | 参考 | DSL設計、ワークフロー定義の参照 |
| **Claude Agent Teams** | 参考 | Hooks連携、統合ポイント |
| **Temporal** | 監視 | 将来的な耐久性実行の統合候補 |

---

## 11. 改訂ロードマップ案

### 現計画の問題

- Phase 1 を「最小運用」としているが、実際には 1-2ヶ月かかる可能性
- 「MVP」タグが付いた要件だけで8カテゴリ、約20項目（本当のMVPは 1/3 程度であるべき）

### 改訂案

```
Week 1-2: プロトタイプ
  - coder 1 + reviewer 1
  - 4状態タスク（queued/claimed/done/failed）
  - 単純mailbox（JSONL）
  - 手動 worker 起動

Week 3-4: 評価 & 再計画
  - プロトタイプの問題点を洗い出し
  - 本当に必要な機能を特定
  - ロードマップ再構築

Week 5-8: Phase 1（claim/lease/requeue）
  - heartbeat + lease 追加
  - dead-letter 追加
  - Git worktree 統合

Week 9-12: Phase 2（並列化 + 品質ゲート）
  - 4並列実装
  - PASS/FAIL ゲート
  - 差し戻しループ
```

---

## 12. ドキュメント改善要求

### 高優先度（実装開始前に必須）

1. **TypeScript型定義の完全化** - Command/Result/Error の全型定義
2. **workflow.yaml の JSON Schema** - バリデーションとエディタ補完
3. **エラーレスポンス標準フォーマット** - デバッグのために必須
4. **最小限のCLI仕様** - 動作確認ができないと開発が進まない

### 中優先度（Phase 1までに）

5. **クイックスタートガイド** - オンボーディング用
6. **状態遷移図** - task/workflow/reservation の3つ
7. **テストフィクスチャ例** - テスト書き始めに必要

### 低優先度（Phase 2以降）

8. **トラブルシューティングガイド** - 運用開始後に追記
9. **パフォーマンスガイドライン** - 負荷テスト後

---

## 13. 結論

### 設計の評価

**方向性は正しいが、実装前に検証が必要。**

- Contract-First、疎結合、非LLM orchestrator の原則は正しい
- スコープが過大で、MVPの再定義が必要
- 既存ツール（特に Git Worktree）の活用が不足

### 推奨アプローチ

**「4ヶ月かけて完璧なシステムを作る」より「2週間で動くものを作り、そこから学ぶ」**

1. **今すぐ**: 2週間でプロトタイプを作る
2. **スコープ削減**: Event Sourcing、Reservation、動的チームを外す
3. **Git Worktree**: ファイル競合回避に採用
4. **再評価**: プロトタイプ後に計画を見直す

### 最終判断

| 観点 | 判断 |
|------|------|
| 設計方針 | 継続 |
| 現計画のスコープ | 縮小が必要 |
| Event Sourcing | MVP から除外 |
| Reservation Module | Git Worktree で代替 |
| 次のアクション | 2週間プロトタイプ |

---

## 付録: レビューエージェント詳細出力

各エージェントの完全なレビュー出力は以下を参照:

- Opus-1（必要性・スコープ）: 過剰設計への警告、最小実装の提案
- Opus-2（アーキテクチャ）: 20の技術的問題点、依存関係の検証
- Opus-3（DX）: 型定義、DSL、CLI、ドキュメントの改善要求
- Opus-4（リスク）: 工数見積、隠れた前提、フォールバックの欠落
- Research（競合調査）: 10+ツールの比較、市場動向
