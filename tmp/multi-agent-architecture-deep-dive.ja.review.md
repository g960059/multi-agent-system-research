# Review: multi-agent-architecture-deep-dive.ja.md

作成日: 2026-02-11  
対象: `docs/multi-agent-architecture-deep-dive.ja.md`

## 判定

Go with changes

## Findings（重大度順）

### High: SoT（単一真実源）が曖昧

- `永続ストアを真実源`としている一方で、`.mailbox/`配下にも状態を持っており、正本/投影の区別が不十分。
- 参照: `docs/multi-agent-architecture-deep-dive.ja.md:209`, `docs/multi-agent-architecture-deep-dive.ja.md:256`, `docs/multi-agent-architecture-deep-dive.ja.md:363`
- 推奨: `event_log` を唯一の正本に固定し、mailboxは再生成可能な投影と明示する。

### High: 再実行時の副作用安全性が不足

- `lease失効 -> requeue` は定義されているが、重複実行時の二重反映防止が未定義。
- 参照: `docs/multi-agent-architecture-deep-dive.ja.md:338`, `docs/multi-agent-architecture-deep-dive.ja.md:345`
- 推奨: `task_run_id` / `fencing_token` / `idempotency_key` を導入し、旧実行の遅延結果を破棄する。

### High: hooks非依存目標との整合不足

- 目標では `hooks利用可否に依存しない` としつつ、Write拒否の強制点が hooks 中心。
- 参照: `docs/multi-agent-architecture-deep-dive.ja.md:61`, `docs/multi-agent-architecture-deep-dive.ja.md:327`, `docs/multi-agent-architecture-deep-dive.ja.md:456`
- 推奨: ポリシー判定本体をruntimeへ移し、hooksはアダプタに限定する。

### Medium: メッセージ信頼性要件がスキーマに未反映

- 問題設定で `順序/重複` を挙げているが、メッセージスキーマにACK/再送/dedupキーが不足。
- 参照: `docs/multi-agent-architecture-deep-dive.ja.md:51`, `docs/multi-agent-architecture-deep-dive.ja.md:376`
- 推奨: `dedup_key`, `delivery_attempt`, `ack_at`, `ordering_scope` を定義する。

### Medium: 閾値が固定値中心で運用適応性が不足

- heartbeat/lease/pollに初期値はあるが、負荷・遅延変動時の調整則がない。
- 参照: `docs/multi-agent-architecture-deep-dive.ja.md:404`, `docs/multi-agent-architecture-deep-dive.ja.md:406`, `docs/multi-agent-architecture-deep-dive.ja.md:407`
- 推奨: `TTL >= 3*heartbeat + scan + jitter` のような算出式と環境別プロファイルを定義する。

### Medium: 実装順序が再実装コストを増やす可能性

- `mailbox先行` で `external orchestrator` が後段のため、後で責務再分割が発生しやすい。
- 参照: `docs/multi-agent-architecture-deep-dive.ja.md:521`, `docs/multi-agent-architecture-deep-dive.ja.md:524`
- 推奨: 先に `state machine + invariants + event log` を固定し、通信層は後からアダプタ化する。

## 総評

- 方向性（推論/制御分離、claim/lease、reservation、adapter戦略）は妥当。
- ただし、実装前に「正本定義」「副作用安全」「hooks非依存の強制点」を仕様として固定しないと、運用時に不整合が発生しやすい。
