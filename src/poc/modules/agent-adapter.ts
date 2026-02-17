// @ts-nocheck

export type ReviewerProvider = "codex" | "claude";

export type ReviewerAgentProfile = {
  id: string;
  provider: ReviewerProvider;
  model?: string;
  instruction?: string;
  display_name?: string;
  prompt_file?: string;
  command_template?: string[];
  env_profile?: string;
  env?: Record<string, string>;
};

export type RuntimeAgentConfig = {
  orchestrator_id: string;
  aggregator_id: string;
  reviewers: ReviewerAgentProfile[];
};

export function buildRuntimeAgentConfig(options?: {
  orchestratorId?: string;
  aggregatorId?: string;
  reviewers?: ReviewerAgentProfile[];
  codexModel?: string;
  claudeModel?: string;
}): RuntimeAgentConfig {
  const orchestratorId = String(options?.orchestratorId ?? "orchestrator").trim() || "orchestrator";
  const aggregatorId = String(options?.aggregatorId ?? "aggregator").trim() || "aggregator";
  const codexModel = options?.codexModel?.trim() ? options.codexModel.trim() : undefined;
  const claudeModel = options?.claudeModel?.trim() ? options.claudeModel.trim() : undefined;

  const defaultReviewers: ReviewerAgentProfile[] = [
    {
      id: "codex",
      provider: "codex",
      model: codexModel
    },
    {
      id: "claude",
      provider: "claude",
      model: claudeModel
    }
  ];

  const reviewersInput = Array.isArray(options?.reviewers) && options?.reviewers.length > 0 ? options.reviewers : defaultReviewers;
  const reviewers = reviewersInput.map((item, index) => {
    const id = String(item?.id ?? "").trim();
    const provider = item?.provider === "claude" ? "claude" : item?.provider === "codex" ? "codex" : "";
    if (!id) {
      throw new Error(`Invalid reviewer profile at index=${index}: missing id`);
    }
    if (!provider) {
      throw new Error(`Invalid reviewer profile ${id}: provider must be codex or claude`);
    }
    const model =
      item?.model?.trim?.() ||
      (provider === "codex" ? codexModel : undefined) ||
      (provider === "claude" ? claudeModel : undefined) ||
      undefined;
    const commandTemplate = Array.isArray(item?.command_template)
      ? item.command_template.map((x) => String(x ?? "").trim()).filter(Boolean)
      : undefined;
    const envProfile = item?.env_profile?.trim?.() || undefined;
    const env =
      item?.env && typeof item.env === "object"
        ? Object.fromEntries(
            Object.entries(item.env)
              .map(([k, v]) => [String(k ?? "").trim(), String(v ?? "")])
              .filter(([k]) => Boolean(k))
          )
        : undefined;
    return {
      id,
      provider,
      model,
      instruction: item?.instruction?.trim?.() || undefined,
      display_name: item?.display_name?.trim?.() || undefined,
      prompt_file: item?.prompt_file?.trim?.() || undefined,
      command_template: commandTemplate && commandTemplate.length > 0 ? commandTemplate : undefined,
      env_profile: envProfile,
      env
    };
  });

  const seen = new Set<string>();
  for (const reviewer of reviewers) {
    if (seen.has(reviewer.id)) {
      throw new Error(`Duplicate reviewer id: ${reviewer.id}`);
    }
    seen.add(reviewer.id);
  }
  if (seen.has(orchestratorId)) {
    throw new Error(`Reviewer id conflicts with orchestrator id: ${orchestratorId}`);
  }
  if (seen.has(aggregatorId)) {
    throw new Error(`Reviewer id conflicts with aggregator id: ${aggregatorId}`);
  }

  return {
    orchestrator_id: orchestratorId,
    aggregator_id: aggregatorId,
    reviewers
  };
}

export function buildAcl(config: RuntimeAgentConfig): {
  task_assignment: string[];
  review_result: string[];
  aggregation_result: string[];
  control: string[];
  error: string[];
} {
  const principals = [
    config.orchestrator_id,
    config.aggregator_id,
    ...config.reviewers.map((x) => x.id)
  ];
  return {
    task_assignment: [config.orchestrator_id],
    review_result: config.reviewers.map((x) => x.id),
    aggregation_result: [config.aggregator_id],
    control: [config.orchestrator_id],
    error: [...new Set(principals)]
  };
}
