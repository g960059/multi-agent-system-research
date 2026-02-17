// @ts-nocheck
import {
  buildRuntimeAgentConfig,
  type ReviewerAgentProfile,
  type RuntimeAgentConfig
} from "./agent-adapter";

export type AgentRole =
  | "reviewer"
  | "coder"
  | "frontend_coder"
  | "backend_coder"
  | "qa_tester"
  | "documenter"
  | "researcher"
  | "architect"
  | "aggregator"
  | "orchestrator";

type AgentDefinition = {
  id: string;
  name?: string;
  role: AgentRole;
  provider: "codex" | "claude" | "local";
  model?: string;
  instruction?: string;
  prompt_file?: string;
  env_profile?: string;
  env?: Record<string, string>;
  allowed_message_types?: string[];
  command_template?: string[];
};

type AgentDefinitionDocument = {
  version: 1;
  env_profiles?: Record<string, Record<string, string>>;
  agents: AgentDefinition[];
};

const ROLE_ALLOWED_MESSAGE_TYPES: Record<AgentRole, string[]> = {
  reviewer: ["task_assignment", "review_result"],
  coder: ["task_assignment", "review_result"],
  frontend_coder: ["task_assignment", "review_result"],
  backend_coder: ["task_assignment", "review_result"],
  qa_tester: ["task_assignment", "review_result"],
  documenter: ["task_assignment", "review_result"],
  researcher: ["task_assignment", "review_result"],
  architect: ["task_assignment", "review_result"],
  aggregator: ["review_result", "aggregation_result"],
  orchestrator: ["task_assignment", "aggregation_result", "control", "error"]
};

const DEFAULT_ENV_PROFILES: Record<string, Record<string, string>> = {
  "codex-reviewer": {
    CODEX_SANDBOX: "read-only",
    CODEX_MODE: "full-auto"
  },
  "claude-reviewer": {},
  "local-default": {}
};

function hasEnvProfile(name: string, customProfiles?: Record<string, Record<string, string>>): boolean {
  return Boolean(DEFAULT_ENV_PROFILES[name] || customProfiles?.[name]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

function defaultCommandTemplateFor(agent: AgentDefinition): string[] {
  if (agent.provider === "codex") {
    return ["codex", "exec", "--full-auto", "--sandbox", "read-only", "--cd", "{repo_root}", "{prompt}"];
  }
  if (agent.provider === "claude") {
    return ["claude", "-p", "{prompt}"];
  }
  if (agent.role === "aggregator") {
    return ["node", "dist/aggregator.js"];
  }
  if (agent.role === "orchestrator") {
    return ["node", "dist/orchestrator.js"];
  }
  return ["node", "dist/worker.js"];
}

function defaultEnvProfileFor(agent: AgentDefinition): string {
  if (agent.provider === "codex") {
    return "codex-reviewer";
  }
  if (agent.provider === "claude") {
    return "claude-reviewer";
  }
  return "local-default";
}

function resolveEnv(
  agent: AgentDefinition,
  customProfiles?: Record<string, Record<string, string>>
): { env_profile: string; env: Record<string, string> } {
  const envProfileName = String(agent.env_profile ?? defaultEnvProfileFor(agent)).trim();
  if (!hasEnvProfile(envProfileName, customProfiles)) {
    throw new Error(`agent ${agent.id} refers to unknown env_profile: ${envProfileName}`);
  }
  const baseProfile = {
    ...(DEFAULT_ENV_PROFILES[envProfileName] ?? {}),
    ...(customProfiles?.[envProfileName] ?? {})
  };
  return {
    env_profile: envProfileName,
    env: {
      ...baseProfile,
      ...(agent.env ?? {})
    }
  };
}

export function applyAgentDefinitionPolicy(doc: AgentDefinitionDocument): AgentDefinitionDocument {
  if (!Array.isArray(doc?.agents) || doc.agents.length === 0) {
    throw new Error("agent definition document must have non-empty agents");
  }
  return {
    ...doc,
    agents: doc.agents.map((agent, index) => {
      if (!agent?.id) {
        throw new Error(`agent at index=${index} is missing id`);
      }
      if (!agent?.role || !ROLE_ALLOWED_MESSAGE_TYPES[agent.role]) {
        throw new Error(`agent ${agent.id} has unsupported role: ${String(agent?.role ?? "")}`);
      }
      if (!["codex", "claude", "local"].includes(agent.provider)) {
        throw new Error(`agent ${agent.id} has unsupported provider: ${String(agent?.provider ?? "")}`);
      }
      const allowedMessageTypes = unique(
        Array.isArray(agent.allowed_message_types) && agent.allowed_message_types.length > 0
          ? agent.allowed_message_types
          : ROLE_ALLOWED_MESSAGE_TYPES[agent.role]
      );
      const commandTemplate =
        Array.isArray(agent.command_template) && agent.command_template.length > 0
          ? [...agent.command_template]
          : defaultCommandTemplateFor(agent);
      const envResolved = resolveEnv(agent, doc.env_profiles);
      return {
        ...agent,
        allowed_message_types: allowedMessageTypes,
        command_template: commandTemplate,
        env_profile: envResolved.env_profile,
        env: envResolved.env
      };
    })
  };
}

export function buildRuntimeAgentConfigFromDefinitions(doc: AgentDefinitionDocument): {
  runtime: RuntimeAgentConfig;
  resolved: AgentDefinitionDocument;
} {
  const resolved = applyAgentDefinitionPolicy(doc);
  const reviewerCandidates = resolved.agents.filter(
    (agent) =>
      agent.role !== "aggregator" &&
      agent.role !== "orchestrator" &&
      Array.isArray(agent.allowed_message_types) &&
      agent.allowed_message_types.includes("review_result")
  );
  const reviewers: ReviewerAgentProfile[] = reviewerCandidates.map((agent) => {
    if (agent.provider !== "codex" && agent.provider !== "claude") {
      throw new Error(
        `agent ${agent.id} has reviewer-capable role (${agent.role}) but unsupported reviewer provider: ${agent.provider}`
      );
    }
    return {
      id: agent.id,
      provider: agent.provider,
      model: agent.model,
      instruction: agent.instruction,
      display_name: agent.name,
      prompt_file: agent.prompt_file,
      command_template: agent.command_template,
      env_profile: agent.env_profile,
      env: agent.env
    };
  });
  const orchestrator = resolved.agents.find((agent) => agent.role === "orchestrator");
  const aggregator = resolved.agents.find((agent) => agent.role === "aggregator");
  const runtime = buildRuntimeAgentConfig({
    orchestratorId: orchestrator?.id ?? "orchestrator",
    aggregatorId: aggregator?.id ?? "aggregator",
    reviewers
  });
  return {
    runtime,
    resolved
  };
}
