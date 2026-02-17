import type { ClaimRequest, ClaimResult, GraphDelta, RunId, TaskAttempt, WorkGraph } from "./types";

export type ApplyGraphDeltaInput = {
  run_id: RunId;
  expected_revision: number;
  proposer_agent_id: string;
  delta_id: string;
  delta: GraphDelta;
};

export type CompleteAttemptInput = {
  attempt: TaskAttempt;
  artifact_refs: string[];
  summary?: string;
};

export type FailAttemptInput = {
  attempt: TaskAttempt;
  failure_class: string;
  reason_code: string;
  detail?: string;
  retryable: boolean;
};

export interface TaskGraphEnginePort {
  getGraph(runId: RunId): Promise<WorkGraph | null>;
  applyGraphDelta(input: ApplyGraphDeltaInput): Promise<{ applied: boolean; new_revision: number; reason_code?: string }>;
  claim(input: ClaimRequest): Promise<ClaimResult>;
  completeAttempt(input: CompleteAttemptInput): Promise<void>;
  failAttempt(input: FailAttemptInput): Promise<void>;
  releaseExpiredLeases(runId: RunId, now: string): Promise<number>;
}
