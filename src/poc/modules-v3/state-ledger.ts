import type { DomainEvent, Envelope, EventRecord, RunId, RunSummary } from "./types";

export type LedgerTransaction = {
  tx_id: string;
};

export interface StateLedgerPort {
  beginTransaction(): Promise<LedgerTransaction>;
  appendEvents(tx: LedgerTransaction, events: DomainEvent[]): Promise<void>;
  appendOutbox(tx: LedgerTransaction, envelopes: Envelope[]): Promise<void>;
  commit(tx: LedgerTransaction): Promise<void>;
  rollback(tx: LedgerTransaction): Promise<void>;
  loadEvents(runId: RunId, fromOffset?: number, limit?: number): Promise<EventRecord[]>;
  loadRunSummary(runId: RunId): Promise<RunSummary | null>;
}
