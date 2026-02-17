import type {
  AgentId,
  AgentProfile,
  ExecutionPolicySnapshot,
  FailureClass,
  GraphDelta,
  PolicyDecision,
  PolicySnapshotId,
  RunId,
  WorkGraph,
  WorkflowSpec
} from "./types";

export type ResolvePolicyInput = {
  run_id: RunId;
  workflow: WorkflowSpec;
  overrides?: Partial<ExecutionPolicySnapshot>;
};

export type AuthorizeCommandInput = {
  run_id: RunId;
  agent_id: AgentId;
  role: string;
  command_name: string;
};

export type ValidateGraphDeltaInput = {
  run_id: RunId;
  proposer: AgentProfile;
  graph: WorkGraph;
  delta: GraphDelta;
  snapshot: ExecutionPolicySnapshot;
};

export type ClassifyFailureInput = {
  error_code: string;
  provider?: string;
  detail?: string;
};

export interface PolicyGovernancePort {
  resolveSnapshot(input: ResolvePolicyInput): Promise<ExecutionPolicySnapshot>;
  getSnapshot(snapshotId: PolicySnapshotId): Promise<ExecutionPolicySnapshot | null>;
  authorizeCommand(input: AuthorizeCommandInput): Promise<PolicyDecision>;
  validateGraphDelta(input: ValidateGraphDeltaInput): Promise<PolicyDecision>;
  classifyFailure(input: ClassifyFailureInput): Promise<{ failure_class: FailureClass; retryable: boolean }>;
}
