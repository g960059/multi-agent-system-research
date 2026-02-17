export type ISO8601 = string;
export type RunId = string;
export type WorkflowId = string;
export type TaskId = string;
export type AttemptId = string;
export type AgentId = string;
export type MessageId = string;
export type ArtifactId = string;
export type PolicySnapshotId = string;

export type AgentProvider = "codex" | "claude" | "local";

export type AgentRole =
  | "orchestrator"
  | "aggregator"
  | "reviewer"
  | "architect"
  | "coder"
  | "frontend_coder"
  | "backend_coder"
  | "qa_tester"
  | "documenter"
  | "researcher";

export type AgentExecutionMode = "subtask" | "teammate";

export type AgentProfile = {
  agent_id: AgentId;
  display_name?: string;
  role: AgentRole;
  provider: AgentProvider;
  model?: string;
  instruction?: string;
  capabilities: string[];
  execution_mode: AgentExecutionMode;
  max_concurrency?: number;
  metadata?: Record<string, string>;
};

export type SwarmRunStatus = "created" | "running" | "paused" | "completed" | "failed" | "canceled";

export type SwarmRun = {
  run_id: RunId;
  workflow_id: WorkflowId;
  workflow_version: number;
  policy_snapshot_id: PolicySnapshotId;
  status: SwarmRunStatus;
  created_at: ISO8601;
  updated_at: ISO8601;
  metadata?: Record<string, string>;
};

export type WorkflowPhaseMode = "sequential" | "parallel";

export type WorkflowGateKind = "quorum" | "all_of" | "manual" | "policy";

export type WorkflowGateSpec = {
  gate_id: string;
  kind: WorkflowGateKind;
  criteria: string;
};

export type WorkflowLoopSpec = {
  enabled: boolean;
  max_epochs: number;
  exit_condition: string;
};

export type WorkflowPhaseSpec = {
  phase_id: string;
  mode: WorkflowPhaseMode;
  task_kinds: string[];
  gates: WorkflowGateSpec[];
  loop?: WorkflowLoopSpec;
};

export type DecompositionPolicy = {
  max_workflow_depth: number;
  max_nodes_per_subworkflow: number;
  max_decomposition_per_task: number;
};

export type WorkflowSpec = {
  workflow_id: WorkflowId;
  version: number;
  phases: WorkflowPhaseSpec[];
  decomposition_policy: DecompositionPolicy;
  budget_policy?: {
    max_attempts_per_task?: number;
    max_runtime_minutes?: number;
    max_tokens_total?: number;
  };
};

export type TaskState = "pending" | "queued" | "leased" | "running" | "completed" | "failed" | "deadletter" | "canceled";

export type WorkNode = {
  task_id: TaskId;
  workflow_path: string;
  epoch: number;
  kind: string;
  summary: string;
  state: TaskState;
  priority: number;
  capability_requirements: string[];
  reservations: string[];
  metadata?: Record<string, string>;
};

export type WorkEdge = {
  from_task_id: TaskId;
  to_task_id: TaskId;
  edge_kind: "hard" | "soft";
};

export type WorkGraph = {
  run_id: RunId;
  revision: number;
  nodes: WorkNode[];
  edges: WorkEdge[];
};

export type GraphDelta = {
  add_nodes: WorkNode[];
  add_edges: WorkEdge[];
  update_nodes: Array<{
    task_id: TaskId;
    patch: Partial<Pick<WorkNode, "summary" | "priority" | "metadata">>;
  }>;
  close_nodes: Array<{
    task_id: TaskId;
    reason_code: string;
  }>;
};

export type WorkerSpec = {
  agent_id: AgentId;
  capabilities: string[];
  service_class: string;
  max_claims: number;
};

export type TaskAttempt = {
  attempt_id: AttemptId;
  run_id: RunId;
  task_id: TaskId;
  agent_id: AgentId;
  attempt_no: number;
  lease_until: ISO8601;
  lease_epoch: number;
  idempotency_key: string;
  started_at: ISO8601;
};

export type FailureClass =
  | "auth_error"
  | "network_error"
  | "execution_error"
  | "validation_error"
  | "policy_violation"
  | "lease_conflict"
  | "state_conflict"
  | "replay_divergence"
  | "artifact_conflict"
  | "timeout"
  | "canceled";

export type DecisionAction = "admit" | "defer" | "reject" | "retry" | "cancel" | "escalate";

export type PolicyDecision = {
  action: DecisionAction;
  reason_code: string;
  detail?: string;
  snapshot_id: PolicySnapshotId;
};

export type ExecutionPolicySnapshot = {
  snapshot_id: PolicySnapshotId;
  contract_version: number;
  created_at: ISO8601;
  policy_hash: string;
  fairness_policy: {
    service_classes: string[];
    starvation_slo_sec: number;
    min_share_per_tree: number;
  };
  decomposition_limits: DecompositionPolicy;
  retry_policy: {
    max_attempts: number;
    backoff_ms: number;
  };
};

export type EnvelopeType =
  | "task_assignment"
  | "review_result"
  | "aggregation_result"
  | "control"
  | "error"
  | "agent_message"
  | "plan_approval_request"
  | "plan_approval_decision"
  | "shutdown_request"
  | "shutdown_approved";

export type Envelope<TPayload = Record<string, unknown>> = {
  schema_version: 1;
  msg_id: MessageId;
  run_id: RunId;
  task_id?: TaskId;
  from: AgentId;
  to: AgentId;
  type: EnvelopeType;
  issued_at: ISO8601;
  attempt_no?: number;
  trace_id?: string;
  parent_event_id?: string;
  payload: TPayload;
};

export type Artifact = {
  artifact_id: ArtifactId;
  run_id: RunId;
  task_id?: TaskId;
  kind: string;
  uri: string;
  checksum?: string;
  created_at: ISO8601;
  metadata?: Record<string, string>;
};

export type OutcomePattern = {
  pattern_id: string;
  run_id: RunId;
  tags: string[];
  summary: string;
  success_rate: number;
  confidence: number;
  observed_count: number;
  last_seen_at: ISO8601;
};

export type DomainEventName =
  | "run_created"
  | "agent_registered"
  | "workflow_compiled"
  | "graph_delta_applied"
  | "task_claimed"
  | "attempt_completed"
  | "attempt_failed"
  | "message_sent"
  | "plan_approval_requested"
  | "plan_approved"
  | "shutdown_requested"
  | "shutdown_approved"
  | "outcome_recorded";

export type DomainEvent = {
  event_name: DomainEventName;
  run_id: RunId;
  task_id?: TaskId;
  agent_id?: AgentId;
  occurred_at: ISO8601;
  payload: Record<string, unknown>;
};

export type EventRecord = DomainEvent & {
  event_id: string;
  offset: number;
};

export type ClaimRequest = {
  run_id: RunId;
  worker: WorkerSpec;
  limit: number;
  now: ISO8601;
};

export type ClaimResult = {
  claimed: boolean;
  attempts: TaskAttempt[];
  reason_code?: string;
};

export type RunSummary = {
  run_id: RunId;
  status: SwarmRunStatus;
  task_counts: Record<TaskState, number>;
  failure_counts: Record<FailureClass, number>;
  started_at: ISO8601;
  updated_at: ISO8601;
};
