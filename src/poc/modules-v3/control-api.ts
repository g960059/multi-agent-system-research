import type {
  AgentId,
  AgentProfile,
  Envelope,
  ExecutionPolicySnapshot,
  GraphDelta,
  RunId,
  RunSummary,
  SwarmRun,
  WorkGraph,
  WorkflowSpec
} from "./types";

export type CreateRunRequest = {
  workflow: WorkflowSpec;
  agents: AgentProfile[];
  policy_overrides?: Partial<ExecutionPolicySnapshot>;
  metadata?: Record<string, string>;
};

export type CreateRunResponse = {
  run: SwarmRun;
  graph: WorkGraph;
};

export type SubmitGraphDeltaRequest = {
  run_id: RunId;
  proposer_agent_id: AgentId;
  expected_revision: number;
  delta_id: string;
  delta: GraphDelta;
};

export interface ControlApiPort {
  createRun(request: CreateRunRequest): Promise<CreateRunResponse>;
  submitGraphDelta(request: SubmitGraphDeltaRequest): Promise<{ accepted: boolean; reason_code?: string }>;
  sendMessage(envelope: Envelope): Promise<void>;
  requestPlanApproval(runId: RunId, requester: AgentId, approver: AgentId, summary: string): Promise<string>;
  approvePlan(runId: RunId, approver: AgentId, requestId: string, approved: boolean, feedback?: string): Promise<void>;
  requestShutdown(runId: RunId, requester: AgentId, target: AgentId, reason: string): Promise<void>;
  approveShutdown(runId: RunId, approver: AgentId, requestId: string): Promise<void>;
  getRunSummary(runId: RunId): Promise<RunSummary | null>;
}
