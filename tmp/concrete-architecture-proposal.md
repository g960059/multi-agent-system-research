# 具体的ユースケースに基づくアーキテクチャ提案

作成日: 2026-02-11

---

## 1. ユースケース定義

### 1.1 ワークフロー

```
Phase 1: 市場調査・論文調査 (3 agent)
    ↓
Phase 2: 要件定義 (1 agent)
    ↓
Phase 3: 実装プラン策定とレビュー (2 agent)
    ↓
Phase 4: 並列実装 (4 agent) + 常駐チーム (2 agent)
         ├─ frontend
         ├─ backend
         ├─ document
         └─ test
         + review (常駐)
         + codebase (常駐)
    ↓
Phase 5: 最終レビュー (3 agent)
         ├─ security
         ├─ performance
         └─ architecture
    ↓
    NG → Phase 4に差し戻し
    OK → 完了
```

### 1.2 技術要件

- **LLM混成**: Claude Code + Codex CLI
- **並列実行**: 最大6 agent同時（Phase 4）
- **常駐チーム**: フェーズをまたいで存続
- **品質ゲート**: 構造化されたPASS/FAIL判定
- **差し戻し**: 自動ルーティング

### 1.3 実際に試して判明した問題

| 問題 | 詳細 |
|------|------|
| Agent TeamからCodex呼び出し不可 | Claude Code内部機能の制限 |
| Skillは一方向呼び出し | 双方向通信不可 |
| プロセスが頻繁に落ちる | Claude Code/Codex両方で発生 |
| フロー強制ツールなし | Claude Code内部で完結しない |

---

## 2. 設計方針

### 2.1 中心的な判断

**Claude Code/Codexの内部機能に依存しない外部オーケストレーターを構築する**

理由:
1. Agent Teams/Skillの制限を回避
2. Claude + Codexの混成チームを統一的に管理
3. プロセス落ちからの復旧を外部で制御
4. フロー強制を確実に実装

### 2.2 設計原則

1. **LLMは「作業者」、オーケストレーターは「指揮者」**
   - オーケストレーターは非LLM（TypeScript）
   - LLMはmailbox経由でタスクを受け取り、結果を返すだけ

2. **プロセス管理は tmux に委譲**
   - Claude Code、Codex CLI を tmux pane で起動
   - クラッシュ検知と respawn を外部で実装

3. **通信は mailbox（ファイル）で統一**
   - Claude/Codex間の直接通信なし
   - 全てオーケストレーター経由

4. **状態は永続ストアに保存**
   - プロセス落ちても状態を復元可能
   - SQLite で十分

---

## 3. アーキテクチャ

### 3.1 全体構成

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR (TypeScript/Node.js)               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Workflow FSM │  │  Scheduler   │  │       Watchdog           │  │
│  │ (状態遷移)   │  │  (配車)      │  │ (heartbeat/respawn)      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                              │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐   │
│  │                    Task Queue (SQLite)                       │   │
│  │  task_id | phase | agent_type | status | owner | lease_until │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │         .mailbox/             │
              │  inbox/<agent>/               │
              │  outbox/<agent>/              │
              │  heartbeat/<agent>            │
              │  state/<task_id>.json         │
              └───────────────┬───────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ tmux session  │    │ tmux session  │    │ tmux session  │
│ ┌───────────┐ │    │ ┌───────────┐ │    │ ┌───────────┐ │
│ │Claude Code│ │    │ │Codex CLI  │ │    │ │Claude Code│ │
│ │(researcher│ │    │ │(frontend) │ │    │ │(reviewer) │ │
│ │-1)        │ │    │ │           │ │    │ │           │ │
│ └───────────┘ │    │ └───────────┘ │    │ └───────────┘ │
└───────────────┘    └───────────────┘    └───────────────┘
```

### 3.2 コンポーネント詳細

#### Orchestrator

```typescript
// src/orchestrator/index.ts
interface Orchestrator {
  // ワークフロー制御
  startWorkflow(workflowId: string): Promise<void>;
  getCurrentPhase(): Phase;
  transitionPhase(from: Phase, to: Phase): Promise<void>;

  // タスク管理
  createTask(task: TaskDefinition): Promise<string>;
  assignTask(taskId: string, agentId: string): Promise<void>;
  completeTask(taskId: string, result: TaskResult): Promise<void>;
  requeueTask(taskId: string): Promise<void>;

  // 品質ゲート
  evaluateGate(gateId: string, results: GateInput[]): GateResult;
  routeOnGateResult(result: GateResult): Promise<void>;
}
```

#### Workflow FSM

```typescript
// src/workflow/fsm.ts
type Phase =
  | 'research'      // Phase 1
  | 'requirements'  // Phase 2
  | 'planning'      // Phase 3
  | 'implementation'// Phase 4
  | 'final_review'  // Phase 5
  | 'completed'
  | 'failed';

interface WorkflowTransition {
  from: Phase;
  to: Phase;
  condition: (state: WorkflowState) => boolean;
  onTransition?: (state: WorkflowState) => Promise<void>;
}

const transitions: WorkflowTransition[] = [
  {
    from: 'research',
    to: 'requirements',
    condition: (s) => s.tasks.research.every(t => t.status === 'done')
  },
  {
    from: 'final_review',
    to: 'implementation',  // 差し戻し
    condition: (s) => s.gates.final_review.result === 'FAIL'
  },
  {
    from: 'final_review',
    to: 'completed',
    condition: (s) => s.gates.final_review.result === 'PASS'
  }
];
```

#### Scheduler

```typescript
// src/scheduler/index.ts
interface Scheduler {
  // タスク取得（Pull型）
  claimTask(agentId: string, agentType: AgentType): Promise<Task | null>;

  // リース管理
  renewLease(taskId: string, agentId: string): Promise<void>;
  expireLeases(): Promise<Task[]>;  // 期限切れタスクを再キュー

  // 常駐チーム管理
  registerPersistentAgent(agentId: string, role: 'review' | 'codebase'): void;
  getPersistentAgents(): Agent[];
}
```

#### Watchdog

```typescript
// src/watchdog/index.ts
interface Watchdog {
  // Heartbeat監視
  checkHeartbeats(): Promise<DeadAgent[]>;

  // プロセス管理
  respawnAgent(agentId: string): Promise<void>;
  killAgent(agentId: string): Promise<void>;

  // リカバリ
  requeueTasksFromDeadAgent(agentId: string): Promise<void>;
}
```

### 3.3 Agent定義

```typescript
// src/agents/types.ts
type AgentType = 'claude-code' | 'codex';

interface AgentDefinition {
  id: string;
  type: AgentType;
  role: AgentRole;
  phase: Phase | 'persistent';  // persistent = 常駐
  config: AgentConfig;
}

type AgentRole =
  // Phase 1
  | 'researcher-market'
  | 'researcher-paper'
  | 'researcher-competitor'
  // Phase 2
  | 'requirements-analyst'
  // Phase 3
  | 'planner'
  | 'plan-reviewer'
  // Phase 4
  | 'impl-frontend'
  | 'impl-backend'
  | 'impl-document'
  | 'impl-test'
  // 常駐
  | 'reviewer'
  | 'codebase-guardian'
  // Phase 5
  | 'reviewer-security'
  | 'reviewer-performance'
  | 'reviewer-architecture';

// エージェント設定例
const agentConfigs: AgentDefinition[] = [
  // Phase 4: 実装チーム（Codex推奨）
  {
    id: 'impl-frontend-1',
    type: 'codex',  // Codex CLI
    role: 'impl-frontend',
    phase: 'implementation',
    config: {
      tmuxSession: 'agents',
      tmuxPane: 'frontend',
      workDir: './src/frontend',
      policy: './policies/frontend.md'
    }
  },
  // 常駐チーム（Claude Code推奨）
  {
    id: 'reviewer-1',
    type: 'claude-code',
    role: 'reviewer',
    phase: 'persistent',
    config: {
      tmuxSession: 'agents',
      tmuxPane: 'reviewer',
      workDir: './',
      policy: './policies/reviewer.md'
    }
  }
];
```

### 3.4 Mailbox構造

```
.mailbox/
├── inbox/
│   ├── impl-frontend-1/
│   │   └── task-001.json      # オーケストレーターからの指示
│   ├── impl-backend-1/
│   ├── reviewer-1/
│   └── ...
├── outbox/
│   ├── impl-frontend-1/
│   │   └── result-001.json    # タスク完了報告
│   └── ...
├── heartbeat/
│   ├── impl-frontend-1        # touch timestamp
│   └── ...
├── state/
│   ├── workflow.json          # ワークフロー状態
│   ├── task-001.json          # タスク詳細
│   └── ...
└── logs/
    └── 2026-02-11.jsonl       # 監査ログ
```

### 3.5 メッセージスキーマ

```typescript
// タスク割り当て（Orchestrator → Agent）
interface TaskAssignment {
  msg_id: string;
  task_id: string;
  type: 'task_assign';
  phase: Phase;
  role: AgentRole;
  instruction: string;
  context: {
    dependencies: string[];     // 依存タスクの結果へのパス
    files: string[];            // 作業対象ファイル
    policy: string;             // ポリシーファイルパス
  };
  lease_seconds: number;
  created_at: string;
}

// タスク完了報告（Agent → Orchestrator）
interface TaskResult {
  msg_id: string;
  task_id: string;
  type: 'task_result';
  status: 'done' | 'failed' | 'blocked';
  output: {
    summary: string;
    files_modified: string[];
    artifacts: string[];        // 生成物へのパス
  };
  // レビュータスクの場合
  review?: {
    verdict: 'PASS' | 'FAIL';
    blocking: Finding[];
    non_blocking: Finding[];
  };
  created_at: string;
}

interface Finding {
  file: string;
  line?: number;
  severity: 'critical' | 'major' | 'minor';
  issue: string;
  suggestion?: string;
}
```

---

## 4. プロセス落ち対策

### 4.1 Heartbeat/Lease

```typescript
// 定数
const HEARTBEAT_INTERVAL = 10_000;  // 10秒
const HEARTBEAT_TTL = 45_000;       // 45秒
const LEASE_TTL = 120_000;          // 2分（LLM処理に余裕を持たせる）
const LEASE_RENEW_INTERVAL = 40_000; // 40秒ごとに更新

// Watchdogの監視ループ
async function watchdogLoop() {
  while (true) {
    await sleep(30_000);  // 30秒ごとにスキャン

    // Heartbeat切れのエージェントを検出
    const deadAgents = await checkHeartbeats();
    for (const agent of deadAgents) {
      console.log(`Agent ${agent.id} is dead, respawning...`);

      // 1. 実行中タスクを再キュー
      await requeueTasksFromDeadAgent(agent.id);

      // 2. tmux respawn
      await respawnAgent(agent);
    }

    // Lease切れタスクを再キュー
    const expiredTasks = await expireLeases();
    for (const task of expiredTasks) {
      console.log(`Task ${task.id} lease expired, requeuing...`);
      await requeueTask(task.id);
    }
  }
}
```

### 4.2 Agent Worker実装

各エージェント（Claude Code/Codex）は以下のワーカースクリプトで起動:

```typescript
// src/worker/agent-loop.ts
async function agentLoop(agentId: string, agentType: AgentType) {
  // Heartbeat開始
  const heartbeatInterval = setInterval(() => {
    touchHeartbeat(agentId);
  }, HEARTBEAT_INTERVAL);

  try {
    while (true) {
      // 1. タスク取得
      const task = await pollInbox(agentId);
      if (!task) {
        await sleep(2000);
        continue;
      }

      // 2. Lease更新ループ開始
      const leaseInterval = setInterval(() => {
        renewLease(task.task_id, agentId);
      }, LEASE_RENEW_INTERVAL);

      try {
        // 3. LLM実行
        const result = await executeLLM(agentType, task);

        // 4. 結果をoutboxに書き込み
        await writeOutbox(agentId, result);
      } finally {
        clearInterval(leaseInterval);
      }
    }
  } finally {
    clearInterval(heartbeatInterval);
  }
}

async function executeLLM(type: AgentType, task: TaskAssignment): Promise<TaskResult> {
  if (type === 'claude-code') {
    return executeClaudeCode(task);
  } else {
    return executeCodex(task);
  }
}
```

### 4.3 tmux respawn

```bash
#!/bin/bash
# scripts/respawn-agent.sh

AGENT_ID=$1
AGENT_TYPE=$2
SESSION="agents"

# 既存ペインを強制終了
tmux kill-pane -t "${SESSION}:${AGENT_ID}" 2>/dev/null || true

# 新規ペイン作成
tmux new-window -t "${SESSION}" -n "${AGENT_ID}"

# エージェント起動
if [ "$AGENT_TYPE" = "claude-code" ]; then
  tmux send-keys -t "${SESSION}:${AGENT_ID}" \
    "npx ts-node src/worker/claude-code-worker.ts --agent ${AGENT_ID}" Enter
else
  tmux send-keys -t "${SESSION}:${AGENT_ID}" \
    "npx ts-node src/worker/codex-worker.ts --agent ${AGENT_ID}" Enter
fi
```

---

## 5. フロー強制

### 5.1 品質ゲート

```typescript
// src/gates/quality-gate.ts
interface QualityGate {
  id: string;
  phase: Phase;
  requiredReviewers: AgentRole[];
  passCriteria: (results: TaskResult[]) => boolean;
}

const finalReviewGate: QualityGate = {
  id: 'final-review',
  phase: 'final_review',
  requiredReviewers: [
    'reviewer-security',
    'reviewer-performance',
    'reviewer-architecture'
  ],
  passCriteria: (results) => {
    // 全レビュアーがPASSを返す必要がある
    return results.every(r => r.review?.verdict === 'PASS');
  }
};

async function evaluateGate(gate: QualityGate): Promise<GateResult> {
  const results = await getTaskResults(gate.phase);
  const passed = gate.passCriteria(results);

  if (!passed) {
    // blockingな指摘を集約
    const blockingFindings = results
      .flatMap(r => r.review?.blocking ?? []);

    return {
      verdict: 'FAIL',
      blocking: blockingFindings,
      action: 'route_back',
      target_phase: 'implementation'
    };
  }

  return { verdict: 'PASS', action: 'proceed' };
}
```

### 5.2 差し戻しロジック

```typescript
// src/orchestrator/routing.ts
async function routeOnGateResult(result: GateResult): Promise<void> {
  if (result.verdict === 'PASS') {
    await transitionPhase('final_review', 'completed');
    return;
  }

  // FAIL → 差し戻し
  console.log('Quality gate failed, routing back to implementation');

  // 1. 問題のあるファイルを特定
  const affectedFiles = result.blocking.map(f => f.file);

  // 2. 該当する実装エージェントを特定
  const targetAgents = determineTargetAgents(affectedFiles);

  // 3. 修正タスクを作成
  for (const agent of targetAgents) {
    await createTask({
      phase: 'implementation',
      role: agent.role,
      instruction: formatFixInstruction(result.blocking),
      context: {
        dependencies: [],
        files: affectedFiles.filter(f => agent.handles(f)),
        policy: agent.config.policy
      }
    });
  }

  // 4. フェーズを戻す
  await transitionPhase('final_review', 'implementation');
}

function determineTargetAgents(files: string[]): AgentDefinition[] {
  return files.map(file => {
    if (file.startsWith('src/frontend/')) return findAgent('impl-frontend');
    if (file.startsWith('src/backend/')) return findAgent('impl-backend');
    if (file.startsWith('docs/')) return findAgent('impl-document');
    if (file.includes('.test.')) return findAgent('impl-test');
    return findAgent('impl-backend');  // fallback
  });
}
```

### 5.3 常駐チームとの連携

```typescript
// src/orchestrator/persistent-agents.ts

// 常駐チームは全フェーズで活動
// 実装フェーズ中、reviewerは随時レビュー依頼を受ける
// codebase-guardianはファイル競合を監視

async function requestReview(
  taskId: string,
  files: string[]
): Promise<void> {
  const reviewer = getPersistentAgent('reviewer');

  await sendToInbox(reviewer.id, {
    type: 'review_request',
    task_id: taskId,
    files,
    instruction: 'Review the following changes for code quality'
  });
}

async function checkFileConflict(
  agentId: string,
  files: string[]
): Promise<boolean> {
  const guardian = getPersistentAgent('codebase-guardian');

  // 排他チェック
  const conflicts = await guardian.checkConflicts(files);
  if (conflicts.length > 0) {
    console.log(`File conflict detected: ${conflicts}`);
    return false;
  }

  // 予約
  await guardian.reserveFiles(agentId, files);
  return true;
}
```

---

## 6. 実装ロードマップ

### Phase 1: 最小動作確認（3日）

```
目標: 2エージェント間の基本通信

実装:
├── .mailbox/ ディレクトリ構造
├── 単一のClaude Codeエージェント（coder）
├── 単一のClaude Codeエージェント（reviewer）
├── シンプルなオーケストレーター（TypeScript）
│   ├── inbox/outbox監視
│   ├── タスク割り当て
│   └── 結果収集
└── tmuxセットアップスクリプト

検証:
- coder → reviewer → coder の1往復が動作すること
- オーケストレーターがルーティングを制御すること
```

### Phase 2: プロセス耐性（3日）

```
目標: プロセス落ちからの復旧

実装:
├── Heartbeat機構
├── Lease機構
├── Watchdog
├── tmux respawn
└── SQLiteでタスク状態永続化

検証:
- エージェントを手動killしても、respawnして継続すること
- 実行中タスクが再キューされること
```

### Phase 3: Claude + Codex混成（3日）

```
目標: 異なるLLMの協調動作

実装:
├── Codex CLIワーカー
├── エージェントタイプ別の実行ロジック
└── タスク→エージェントタイプのマッピング

検証:
- Claude Codeでplan → Codexで実装 → Claude Codeでレビュー
  の流れが動作すること
```

### Phase 4: 並列実行（3日）

```
目標: 4+ エージェントの同時実行

実装:
├── 並列タスク配車
├── ファイル予約機構
├── 常駐エージェント
└── tmux複数ペイン管理

検証:
- frontend/backend/document/testの4並列が動作すること
- ファイル競合が発生しないこと
```

### Phase 5: 品質ゲート（3日）

```
目標: 差し戻しループの動作

実装:
├── 品質ゲート評価
├── 差し戻しルーティング
├── 修正タスク生成
└── 完了判定

検証:
- レビューFAIL → 実装に差し戻し → 再レビュー
  のループが動作すること
```

### Phase 6: フルワークフロー（3日）

```
目標: 全5フェーズの統合動作

実装:
├── 全フェーズの定義
├── フェーズ遷移ロジック
├── 全エージェント設定
└── ワークフロー監視UI（CLI）

検証:
- 調査→要件→計画→実装→レビューの全フローが動作すること
```

---

## 7. ディレクトリ構成

```
multi-agent-orchestrator/
├── src/
│   ├── orchestrator/
│   │   ├── index.ts           # メインエントリ
│   │   ├── workflow-fsm.ts    # 状態機械
│   │   └── routing.ts         # ルーティングロジック
│   ├── scheduler/
│   │   ├── index.ts
│   │   ├── claim.ts           # タスク取得
│   │   └── lease.ts           # リース管理
│   ├── watchdog/
│   │   ├── index.ts
│   │   ├── heartbeat.ts
│   │   └── respawn.ts
│   ├── worker/
│   │   ├── agent-loop.ts      # 共通ループ
│   │   ├── claude-code-worker.ts
│   │   └── codex-worker.ts
│   ├── mailbox/
│   │   ├── index.ts
│   │   ├── reader.ts
│   │   └── writer.ts
│   ├── gates/
│   │   └── quality-gate.ts
│   ├── store/
│   │   ├── sqlite.ts
│   │   └── schema.sql
│   └── types/
│       ├── agent.ts
│       ├── task.ts
│       └── message.ts
├── config/
│   ├── workflow.yaml          # ワークフロー定義
│   ├── agents.yaml            # エージェント設定
│   └── gates.yaml             # 品質ゲート設定
├── policies/
│   ├── researcher.md
│   ├── planner.md
│   ├── frontend.md
│   ├── backend.md
│   ├── reviewer.md
│   └── security-reviewer.md
├── scripts/
│   ├── setup-tmux.sh
│   ├── respawn-agent.sh
│   └── start-orchestrator.sh
├── .mailbox/                  # 通信ディレクトリ（gitignore）
├── data/                      # SQLite等（gitignore）
└── package.json
```

---

## 8. 既存設計との差分

### 変更点

| 項目 | 元の設計 | 本提案 |
|------|----------|--------|
| スコープ | 汎用基盤 | 具体的ユースケース |
| LLM | Claude Code中心 | Claude + Codex混成 |
| 開始点 | v0でmailbox + task schema + gate | 2エージェント通信のみ |
| 複雑性 | Event Sourcing, DAG等 | 最小限から段階的に |
| 検証 | 設計先行 | 動作確認先行 |

### 維持する点

- 非LLMオーケストレーター
- mailboxベース通信
- tmuxによるプロセス管理
- claim/lease/heartbeat
- 品質ゲート→差し戻し

---

## 9. リスクと対策

| リスク | 対策 |
|--------|------|
| Codex CLIの挙動差異 | まずClaude Code単体で動作確認後にCodex追加 |
| 並列時のファイル競合 | codebase-guardian常駐による予約機構 |
| LLMの構造化出力失敗 | JSON Parse失敗時のリトライ/フォールバック |
| 長時間タスクのLease切れ | タスク種別に応じたLease TTL調整 |
| tmux複数ペイン管理の複雑化 | 最大8ペインに制限、必要に応じてセッション分割 |

---

## 10. 次のアクション

1. **Phase 1の実装開始**
   - `.mailbox/`構造の作成
   - 最小限のオーケストレーター実装
   - Claude Code 2エージェントでの動作確認

2. **TAKTの動作確認**
   - `npm install -g takt`でインストール
   - 実際にワークフローを動かして設計の参考に

3. **ポリシーファイルの作成**
   - 各ロールの責務・制約を明文化
   - 構造化出力のフォーマット定義

---

## 付録: エージェント間通信のシーケンス例

### Phase 4: 実装 → レビュー → 修正

```
Orchestrator          impl-frontend-1       reviewer-1
     │                      │                   │
     │──[task_assign]──────▶│                   │
     │   "Implement login"  │                   │
     │                      │                   │
     │                      │──[work]──────────▶│ (実装中)
     │                      │                   │
     │◀──[task_result]──────│                   │
     │   files: [login.tsx] │                   │
     │                      │                   │
     │──[review_request]────────────────────────▶│
     │   files: [login.tsx] │                   │
     │                      │                   │
     │◀──[task_result]──────────────────────────│
     │   verdict: FAIL      │                   │
     │   blocking: [XSS]    │                   │
     │                      │                   │
     │──[task_assign]──────▶│                   │
     │   "Fix XSS issue"    │                   │
     │                      │                   │
     ...
```
