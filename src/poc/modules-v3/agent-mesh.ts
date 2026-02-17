import type { AgentExecutionMode, AgentId, AgentProfile, FailureClass, RunId, TaskAttempt } from "./types";

export type SpawnAgentInput = {
  run_id: RunId;
  profile: AgentProfile;
  execution_mode?: AgentExecutionMode;
};

export type SpawnAgentResult = {
  agent_id: AgentId;
  instance_id: string;
  execution_mode: AgentExecutionMode;
};

export type ExecuteAttemptResult =
  | {
      status: "completed";
      artifact_refs: string[];
      summary?: string;
    }
  | {
      status: "failed";
      failure_class: FailureClass;
      reason_code: string;
      detail?: string;
      retryable: boolean;
    };

export interface AgentMeshPort {
  spawnAgent(input: SpawnAgentInput): Promise<SpawnAgentResult>;
  stopAgent(runId: RunId, agentId: AgentId, reason: string): Promise<void>;
  heartbeat(runId: RunId, agentId: AgentId, at: string): Promise<void>;
  executeAttempt(runId: RunId, attempt: TaskAttempt): Promise<ExecuteAttemptResult>;
}
