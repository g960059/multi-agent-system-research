# multi-agent-architecture-deep-dive.ja.md レビュー

レビュー日: 2026-02-11
レビュアー: Claude Opus 4.5（6エージェントチーム調査に基づく）

---

## 概要

本レビューは、`docs/multi-agent-architecture-deep-dive.ja.md`に対する批判的評価と改善提案です。

調査チーム構成:
- Opus 4名: ドキュメント分析、要件定義、アーキテクチャ設計
- Research 2名: 参照リンク検証、LangChain批判調査、軽量代替手法調査

---

## 1. 参照ソースの検証結果

### 1.1 各ソースの実態

| ソース | 成熟度 | コミット | スター | 実態 |
|--------|--------|---------|--------|------|
| ChainCrew (zaico記事) | 低 | 7 | 8 | 65日間検証の知見は貴重だが、コード未成熟 |
| Agent Teams + Hooks検証 (tarouimo記事) | 検証段階 | - | - | 公開リポジトリなし、概念実証のみ |
| multi-agent-shogun | **高** | 116 | 818 | Shell実装で成熟、並列実行の実績あり |
| TAKT | **非常に高** | 401 | 313 | TypeScript、npm公開済み、本番対応に最も近い |
| Swarm Tools | 中 | 不明 | 不明 | OpenCode依存、技術詳細不足 |

### 1.2 問題点

**元ドキュメントの問題**: 参照ソースを「読んだ」だけで「動かした」形跡がない

- ChainCrew/TAKTのコードを実際にcloneして動作確認した記録がない
- 各ソースの「強み・弱み」は読んだ情報の要約に過ぎない
- 実際に2エージェント間でmailbox通信を試した証拠がない

**推奨**: 設計文書を書く前に最小限の動作コードを作り、問題を体感すべき

---

## 2. LangChain/LangGraph批判の調査結果

### 2.1 批判の実態

元ドキュメントではLangGraphを「ワークフロー実行エンジンとして親和性が高い」と評価していたが、以下の批判が存在する:

#### 過度な抽象化
> 「5層もの抽象化を通過して、ちょっとした詳細を変更するだけ」という開発体験が報告されている

#### 依存関係の肥大化
- 標準インストールで**80以上のパッケージ**を取り込む
- JavaScript版は展開サイズ**5.4MB**

#### デバッグの困難さ
> 「明確な可観測性がなければ、問題が発生するたびに開発者は本質的に自分のスタックをリバースエンジニアリングすることになる」

#### 本番環境での実績
- **Octomind社**: LangChainを12ヶ月間本番使用後、2024年に削除
  > 「要件が増えるにつれて、LangChainは助けから障害に変わった」

#### LangGraph特有の問題
- 並列状態更新中のレース条件
- 「線形エージェントよりも前払いの設計コストが高い」
- 「単純なチャットボットや単一ステップのタスクには過剰」

### 2.2 元ドキュメントへの影響

元ドキュメントの「LangGraphを参考に」という推奨は**再検討が必要**。

特に本プロジェクトのような:
- シンプルなcoder/reviewerループ
- ファイルベース通信
- 非LLMオーケストレーター

という要件には、LangGraphは**オーバーキル**の可能性が高い。

---

## 3. 軽量代替手法の存在

元ドキュメントでは検討されていなかった軽量代替手法:

### 3.1 直接API呼び出し

**OpenAI Agents SDK** (2025年リリース):
- 3つの核となる概念のみ: Agents, Handoffs, Guardrails
- 100以上のLLMをサポート
- LangChainの複雑さなし

### 3.2 軽量ライブラリ

| ライブラリ | 特徴 | 複雑性 |
|-----------|------|--------|
| **Pydantic AI** | 型安全、マルチエージェント委譲パターン | 低 |
| **Mirascope** | 「LLM Anti-Framework」を標榜 | 低 |
| **Agno** | LangGraphの**50倍少ないメモリ** | 低〜中 |
| **LiteLLM** | 100+ LLM API統一インターフェース | 低 |

### 3.3 ReActループの自作

フレームワークなしで**70行程度**で実装可能:

```python
def agent_loop(prompt, tools):
    messages = [{"role": "user", "content": prompt}]
    while True:
        response = openai.ChatCompletion.create(
            model="gpt-4",
            messages=messages,
            tools=tools
        )
        if response.choices[0].message.tool_calls:
            # ツール実行
            ...
        else:
            return response.choices[0].message.content
```

### 3.4 元ドキュメントへの影響

元ドキュメントは「Swarm Tools」「TAKT」等の独自フレームワークを参照しているが、より成熟した軽量代替手法（Pydantic AI、OpenAI Agents SDK等）の検討が欠けている。

---

## 4. 公式ドキュメント（Claude Code）の検証

### 4.1 Agent Teams

**成熟度: Experimental（実験的）**

> "Agent teams are experimental and disabled by default."

明確に文書化された制限:
1. セッション再開不可（/resume, /rewindがチームメイトを復元しない）
2. タスクステータスの遅延
3. 1セッション1チーム制限
4. ネストチーム不可
5. リード固定

**元ドキュメントへの影響**: Agent Teamsを前提とした設計は、experimentalステータスによるリスクを考慮すべき

### 4.2 Hooks

**成熟度: 安定版（experimentalと明記されていない）**

14種類のイベントをサポート:
- SessionStart, UserPromptSubmit, PreToolUse, PostToolUse
- TeammateIdle, TaskCompleted, PreCompact, etc.

**重要な発見（tarouimo記事より）**:

Hookタイプごとのブロッキング方法が**非統一**:

| Hook | ブロッキング方法 |
|------|------------------|
| PreToolUse | JSON決定 + exit 0 |
| TaskCompleted | exit 2 + stderr |
| TeammateIdle | exit 2 + stderr |

> 「5案中4案でHookタイプを間違えた」

**元ドキュメントへの影響**: Hooks依存設計は、この非統一性を考慮した実装が必要

---

## 5. 抜本的な問題点

### 5.1 スコープの曖昧さ

**問題**: 「マルチエージェント基盤」は抽象的すぎる

元ドキュメントには:
- 具体的なユースケースがない
- 「この基盤で最初に解く問題」が不明確
- 「基盤を作る」ことが目的化している

**改善案**: 「PRレビュー自動化」「ドキュメント生成」等、具体的なユースケースを1つ定義してから設計する

### 5.2 過剰設計

**問題**: v0の段階で不要な機能まで設計している

元ドキュメントに含まれる「v0で不要」な要素:
- DAG decomposition
- 動的チーム招集・解散
- Event Sourcing
- file reservation
- broadcast制御

**改善案**: 本当のv0は「2つのclaude codeプロセス間でファイル経由でメッセージ交換する」だけでいい

### 5.3 検証なしの設計

**問題**: 机上の空論リスク

- 参照ソースを「読んだ」だけで「動かした」形跡がない
- 「こうすればうまくいくはず」という推測ベースの設計
- 実際の問題を体感していない

**改善案**: 設計文書を書く前に1週間で動く最小限のコードを作る

### 5.4 「強制」への過度な執着

**問題**: 「LLMにお願いするのではなく強制する」思想が過剰

元ドキュメントの主張:
> 「AGENTS.md と skill はガイドであり、強制力は弱いです。強制は外部で実施します」

しかし:
- 強制の仕組み（hooks, runtime validation）を作り込むコストが高い
- LLMが自然に従う良いプロンプト設計の方が現実的な場合も多い
- 「強制が必要な場面」と「不要な場面」の区別がない

**改善案**: まずAGENTS.mdで明確に指示し、それで不十分な場合のみ強制機構を追加

### 5.5 Hooks依存度

**問題**: Claude Code Hooksは実験的要素を含む

- Agent Teamsはexperimental
- 仕様変更で設計が壊れるリスク
- hooksがない環境での動作が本当に担保されるか疑問

**改善案**: hooks非依存の外部script版を先に実装し、hooksは「強化オプション」として後から追加

---

## 6. 構成の再考案

### 6.1 現在の構成の問題

元ドキュメントの構成:
1. 問題設定 → 2. ソース比較 → 3. 設計原則 → 4. 推奨アーキテクチャ → 5. 詳細設計 → 6. ロードマップ

**問題**: 「動かす前に設計しすぎている」

### 6.2 推奨する構成

```
1. 具体的なユースケース定義
   └─ 「PRレビュー自動化」等、1つの明確な問題

2. 最小動作確認（1週間）
   └─ coder + reviewer の2エージェントをファイル経由で通信させる

3. 問題の発見と記録
   └─ 実際に動かして発生した問題をリスト化

4. 問題ベースの設計
   └─ 発見した問題に対する解決策を設計

5. 段階的実装
   └─ 問題が発生したら対処、の繰り返し
```

### 6.3 推奨するロードマップの修正

| Phase | 現在の定義 | 修正案 |
|-------|-----------|--------|
| v0 | mailbox + task schema + gate | **ファイル経由の単純なメッセージ交換のみ** |
| v0.5 | - | **1つの具体的タスクをend-to-endで動かす** |
| v1 | claim/lease/heartbeat... | **問題が発生してから対処を設計** |
| v2+ | file reservation... | **必要性が証明されてから追加** |

---

## 7. 具体的な改善提案

### 7.1 即座に実施すべきこと

1. **具体的なユースケースの定義**
   - 「このリポジトリのPRを自動レビューする」
   - 「この仕様書からコードを生成してテストを通す」
   - 等、1つの明確な問題を定義

2. **最小動作コードの作成（1週間以内）**
   ```
   coder (tmux pane 1)
       ↓ .mailbox/inbox/reviewer/msg.json
   reviewer (tmux pane 2)
       ↓ .mailbox/inbox/coder/msg.json
   coder
   ```
   これだけを動かす

3. **TAKTの実際の動作確認**
   - `npm install -g takt`でインストール
   - 実際にワークフローを動かしてみる
   - 設計の参考になる点・ならない点を体感

### 7.2 設計文書の修正

1. **スコープの明確化**
   - 冒頭に「このシステムで解く具体的な問題」を追加
   - 「基盤」ではなく「問題解決」にフォーカス

2. **参照ソースの優先度付け**
   - TAKT: 最も成熟、設計参考として最優先
   - multi-agent-shogun: 並列実行の参考
   - ChainCrew: Hook APIの挙動理解用
   - Swarm Tools: 概念レベルの参考に留める

3. **LangGraph/LangChainへの言及削除または修正**
   - 「親和性が高い」→「過剰設計のリスクがある」に修正
   - 軽量代替手法（Pydantic AI等）への言及を追加

4. **ロードマップの簡素化**
   - v0〜v5の詳細設計を削除
   - 「最小動作確認 → 問題発見 → 対処」のサイクルに変更

### 7.3 技術選定の再考

| 現在の推奨 | 再考案 |
|-----------|--------|
| workflow YAML + external orchestrator | まずシェルスクリプトで十分 |
| SQLite/libSQL (event sourcing) | 最初はJSONファイルで十分 |
| TypeScript monorepo | 最初は単一スクリプトで十分 |
| Hook Adapter Framework | hooks非依存で先に動かす |

---

## 8. 結論

### 8.1 元ドキュメントの評価

**良い点:**
- 問題の分解が的確（失敗モードからの設計）
- 「なぜその結論に至ったか」を記録している
- 段階的導入の意識がある

**改善が必要な点:**
- スコープが曖昧（「基盤」が目的化）
- 検証なしの設計（机上の空論リスク）
- 過剰設計（v0で不要な機能まで設計）
- 参照ソースの検証不足（読んだだけで動かしていない）
- LangGraph等のリスク未考慮

### 8.2 最終提言

> **「正しい設計」より「早く動かして学ぶ」方が、結果的に良い設計に辿り着く**

1. 今の設計文書は「参考資料」として保存
2. 2-3日で動く最小限の2エージェント協調を実装
3. そこで発見した問題を元に設計を修正
4. 必要に応じて既存フレームワーク（TAKT、Pydantic AI等）の活用を再検討

---

## 付録: 調査で判明した重要な知見

### A. TAKTが最も成熟している

- 401コミット、npm公開済み
- プロジェクト自体がTAKTで開発されている（Dogfooding）
- 日本語ドキュメントあり
- 実際にインストールして動作確認が可能

### B. Hookタイプごとのブロッキング方法が異なる

公式ドキュメントには明記されていない重要な知見:
- PreToolUse: JSON決定 + exit 0
- TaskCompleted/TeammateIdle: exit 2 + stderr

### C. Agent Teamsはexperimental

セッション再開不可、1セッション1チーム制限など、本番使用にはリスクがある。

### D. 軽量代替手法が存在する

- OpenAI Agents SDK: 3概念のみ
- Pydantic AI: 型安全なエージェント
- Agno: LangGraphの50倍少ないメモリ
- ReAct自作: 70行で実装可能

### E. 「フレームワークなし」が最良の場合がある

> "LangChain provides a reasonable starting point for prototyping, but enterprise teams often reach scenarios where the best framework is no framework."

---

## 参考文献

### 調査で使用したソース

1. [ChainCrew (zaico記事)](https://zenn.dev/zaico/articles/d6b882c78fe4b3)
2. [Agent Teams + Hooks検証 (tarouimo記事)](https://zenn.dev/tarouimo/articles/9aace19fa1c271)
3. [multi-agent-shogun](https://github.com/yohey-w/multi-agent-shogun)
4. [TAKT](https://github.com/nrslib/takt)
5. [Swarm Tools Docs](https://www.swarmtools.ai/docs)
6. [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
7. [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
8. [Why We No Longer Use LangChain (Octomind)](https://www.octomind.dev/blog/why-we-no-longer-use-langchain-for-building-our-ai-agents)
9. [LangChain Alternatives (Mirascope)](https://mirascope.com/blog/langchain-alternatives)
10. [Pydantic AI Multi-Agent](https://ai.pydantic.dev/multi-agent-applications/)
11. [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
12. [Build AI Agents From Scratch](https://www.pondhouse-data.com/blog/ai-agents-from-scratch)
