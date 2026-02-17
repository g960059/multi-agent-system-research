import type { RunId, WorkflowSpec, WorkGraph } from "./types";

export type CompileWorkflowInput = {
  run_id: RunId;
  workflow: WorkflowSpec;
};

export type CompileWorkflowResult = {
  graph: WorkGraph;
  compile_hash: string;
  warnings: string[];
};

export interface WorkflowCompilerPort {
  validate(workflow: WorkflowSpec): Promise<{ ok: boolean; errors: string[] }>;
  compile(input: CompileWorkflowInput): Promise<CompileWorkflowResult>;
}
