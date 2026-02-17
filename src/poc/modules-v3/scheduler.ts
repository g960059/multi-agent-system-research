import type { ExecutionPolicySnapshot, RunId, TaskId, WorkNode, WorkerSpec } from "./types";

export type ScoredTask = {
  task_id: TaskId;
  tree_id: string;
  score: number;
};

export type SchedulerDecision = {
  selected_task_id: TaskId | null;
  reason_code: string;
  diagnostics?: Record<string, string | number>;
};

export interface SchedulerPort {
  scoreReadyTasks(runId: RunId, readyTasks: WorkNode[], policy: ExecutionPolicySnapshot): Promise<ScoredTask[]>;
  selectNext(runId: RunId, worker: WorkerSpec, readyTasks: WorkNode[], policy: ExecutionPolicySnapshot): Promise<SchedulerDecision>;
}
