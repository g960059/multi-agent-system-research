/**
 * Process Manager boundary contracts for mailbox-only PoC.
 *
 * Wire contract policy:
 * - Wire payload keys are snake_case and align with JSON Schema.
 * - Internal camelCase mapping is allowed only inside adapter mapper layers.
 */

export type TaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "deadletter";

export type ReviewVerdict = "PASS" | "FAIL";

export interface ReviewResultSnapshot {
  msg_id: string;
  agent_id: "codex" | "claude";
  verdict: ReviewVerdict;
  blocking_count: number;
  state_version: number;
  received_at: string;
}

/**
 * Pure domain aggregate. No I/O references.
 */
export interface TaskAggregate {
  task_id: string;
  status: TaskStatus;
  owner: string | null;
  attempt_count: number;
  max_attempts: number;
  lease_until: string | null;
  state_version: number;
  required_reviewer_ids: Array<"codex" | "claude">;
  review_quorum: "all";
  received_review_results: Partial<Record<"codex" | "claude", ReviewResultSnapshot>>;
}

export type TaskCommand =
  | {
      command_type: "assign_task";
      task_id: string;
      worker_id: string;
      lease_until: string;
      now: string;
    }
  | {
      command_type: "record_review_result";
      task_id: string;
      agent_id: "codex" | "claude";
      msg_id: string;
      verdict: ReviewVerdict;
      blocking_count: number;
      now: string;
    }
  | {
      command_type: "soft_timeout";
      task_id: string;
      now: string;
    }
  | {
      command_type: "hard_timeout";
      task_id: string;
      now: string;
    }
  | {
      command_type: "requeue_expired";
      task_id: string;
      now: string;
    };

export type DomainEvent =
  | {
      schema_version: 1;
      event_type: "TaskAssigned";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        worker_id: string;
      };
    }
  | {
      schema_version: 1;
      event_type: "ReviewResultReceived";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        agent_id: "codex" | "claude";
        msg_id: string;
        verdict: ReviewVerdict;
        blocking_count: number;
      };
    }
  | {
      schema_version: 1;
      event_type: "ReviewQuorumReached";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        required_reviewer_ids: Array<"codex" | "claude">;
        received_reviewer_ids: Array<"codex" | "claude">;
      };
    }
  | {
      schema_version: 1;
      event_type: "AggregationDecided";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        verdict: ReviewVerdict;
        blocking_count: number;
        disagree: boolean;
        next_action: "proceed" | "rework" | "manual_review_required";
      };
    }
  | {
      schema_version: 1;
      event_type: "TaskSoftTimedOut";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        reason: string;
      };
    }
  | {
      schema_version: 1;
      event_type: "TaskHardTimedOut";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        reason: string;
      };
    }
  | {
      schema_version: 1;
      event_type: "TaskRequeued";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        attempt_count: number;
        reason: string;
      };
    }
  | {
      schema_version: 1;
      event_type: "TaskCompleted";
      task_id: string;
      state_version: number;
      occurred_at: string;
      payload: {
        verdict: ReviewVerdict;
      };
    };

export interface DomainDecision {
  next: TaskAggregate;
  events: DomainEvent[];
}

/**
 * Pure state machine. No mailbox/provider/database operations.
 */
export interface TaskDomainPort {
  evaluate(current: TaskAggregate, command: TaskCommand): DomainDecision;
}

export type TxCommand =
  | {
      schema_version: 1;
      phase: "tx";
      command_type: "enqueue_outbox";
      task_id: string;
      state_version: number;
      payload: {
        message_type: "task_assignment" | "review_result" | "aggregation_result" | "error" | "control";
        to: string;
        body: Record<string, unknown>;
      };
    }
  | {
      schema_version: 1;
      phase: "tx";
      command_type: "persist_message_receipt";
      task_id: string;
      payload: {
        agent_id: string;
        msg_id: string;
        processed_at: string;
      };
    }
  | {
      schema_version: 1;
      phase: "tx";
      command_type: "persist_nonce";
      task_id: string;
      payload: {
        sender_id: string;
        nonce: string;
        issued_at: string;
        expire_at: string;
      };
    }
  | {
      schema_version: 1;
      phase: "tx";
      command_type: "requeue_task";
      task_id: string;
      payload: {
        reason: string;
      };
    };

export type PostCommitCommand =
  | {
      schema_version: 1;
      phase: "post_commit";
      command_type: "request_cancel_execution";
      task_id: string;
      payload: {
        reason: string;
      };
    }
  | {
      schema_version: 1;
      phase: "post_commit";
      command_type: "force_stop_execution";
      task_id: string;
      payload: {
        reason: string;
      };
    }
  | {
      schema_version: 1;
      phase: "post_commit";
      command_type: "ack_message";
      task_id: string;
      payload: {
        agent_id: string;
        msg_id: string;
      };
    }
  | {
      schema_version: 1;
      phase: "post_commit";
      command_type: "nack_message";
      task_id: string;
      payload: {
        agent_id: string;
        msg_id: string;
        reason: string;
      };
    };

export interface ProcessManagerPlan {
  schema_version: 1;
  tx_commands: TxCommand[];
  post_commit_commands: PostCommitCommand[];
}

/**
 * Side-effect planner. Converts domain events into tx/post-commit commands.
 */
export interface ProcessManagerPort {
  plan(events: DomainEvent[]): ProcessManagerPlan;
}

export interface TxPort {
  run_in_tx<T>(fn: () => Promise<T>): Promise<T>;
}

export interface OutboxItem {
  outbox_id: string;
  task_id: string;
  message_type: "task_assignment" | "review_result" | "aggregation_result" | "error" | "control";
  payload: Record<string, unknown>;
  state_version: number;
  delivery_attempt: number;
}

export interface OutboxPort {
  append(item: Omit<Extract<TxCommand, { command_type: "enqueue_outbox" }>, "schema_version" | "phase" | "command_type">): Promise<string>;
  reserve_batch(limit: number, now: string): Promise<OutboxItem[]>;
  mark_delivered(outbox_id: string, delivered_at: string): Promise<void>;
  mark_failed(outbox_id: string, reason: string): Promise<void>;
}

export interface MessageReceiptPort {
  insert_receipt(task_id: string, agent_id: string, msg_id: string, processed_at: string): Promise<void>;
}

export interface NonceStorePort {
  put_nonce(sender_id: string, nonce: string, issued_at: string, expire_at: string): Promise<void>;
}

export interface MailboxEnvelope {
  msg_id: string;
  schema_version: 1;
  task_id: string;
  sender_id: "orchestrator" | "codex" | "claude" | "aggregator";
  sender_instance_id: string;
  key_id: string;
  issued_at: string;
  nonce: string;
  signature: string;
  from: string;
  to: string;
  type: "task_assignment" | "review_result" | "aggregation_result" | "error" | "control";
  state_version: number;
  parent_id?: string;
  delivery_attempt: number;
  created_at: string;
  payload: Record<string, unknown>;
}

/**
 * Receiver-side identity rule:
 * - from must equal sender_id
 * - sender_id is the only ACL principal
 */

export interface MailboxTransportPort {
  /**
   * Receiver-side mandatory checks (PoC v1):
   * - review_result / aggregation_result must satisfy envelope.task_id === payload.task_id
   * - mismatch must be quarantined and never used for state transitions
   */
  publish(message: MailboxEnvelope): Promise<string>;
  consume(agent_id: string, limit: number): Promise<MailboxEnvelope[]>;
  ack(agent_id: string, msg_id: string): Promise<void>;
  nack(agent_id: string, msg_id: string, reason: string): Promise<void>;
}

/**
 * Provider runtime abstraction. Codex/Claude differences stay here.
 * Pull model: execution start is triggered by Worker Runner after
 * consume + receipt persist + ack, not by ProcessManager commands.
 */
export interface StartExecutionInput {
  task_id: string;
  agent_id: string;
  provider: "codex" | "claude" | "local";
  model: string;
  prompt_file: string;
  payload: Record<string, unknown>;
  soft_timeout_sec: number;
  hard_timeout_sec: number;
}

export interface ExecutionHandle {
  run_id: string;
  task_id: string;
  agent_id: string;
  started_at: string;
}

export interface ExecutionAdapterPort {
  start(input: StartExecutionInput): Promise<ExecutionHandle>;
  request_cancel(handle: ExecutionHandle, reason: string): Promise<void>;
  force_stop(handle: ExecutionHandle, reason: string): Promise<void>;
}
