import type { AgentProfile, RunId, SwarmRun, SwarmRunStatus, WorkflowSpec } from "./types";

export type CreateRunInput = {
  workflow: WorkflowSpec;
  policy_snapshot_id: string;
  metadata?: Record<string, string>;
};

export interface RunspacePort {
  createRun(input: CreateRunInput): Promise<SwarmRun>;
  getRun(runId: RunId): Promise<SwarmRun | null>;
  updateRunStatus(runId: RunId, status: SwarmRunStatus): Promise<void>;
  registerAgent(runId: RunId, profile: AgentProfile): Promise<void>;
  listAgents(runId: RunId): Promise<AgentProfile[]>;
}
