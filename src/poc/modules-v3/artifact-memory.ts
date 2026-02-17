import type { Artifact, ArtifactId, OutcomePattern, RunId, TaskId } from "./types";

export type ListArtifactsInput = {
  run_id: RunId;
  task_id?: TaskId;
  kind?: string;
  limit?: number;
};

export type FindOutcomePatternsInput = {
  tags?: string[];
  query?: string;
  limit?: number;
};

export interface ArtifactMemoryPort {
  putArtifact(artifact: Artifact): Promise<ArtifactId>;
  getArtifact(artifactId: ArtifactId): Promise<Artifact | null>;
  listArtifacts(input: ListArtifactsInput): Promise<Artifact[]>;
  recordOutcomePattern(pattern: OutcomePattern): Promise<void>;
  findOutcomePatterns(input: FindOutcomePatternsInput): Promise<OutcomePattern[]>;
}
