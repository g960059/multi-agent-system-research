// @ts-nocheck
import * as crypto from "node:crypto";

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined) {
      return "";
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function signatureForEnvelope(envelope: any): string {
  const target = { ...envelope, signature: "" };
  const canonical = stableStringify(target);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function validateEnvelope(
  envelope: any,
  options: {
    requireTaskIdMatch: boolean;
    taskIdMatchTypes: string[];
    acl: {
      task_assignment: string[];
      review_result: string[];
      aggregation_result: string[];
      control: string[];
      error: string[];
    };
    aggregationResultTarget: string;
  }
): { ok: boolean; code?: string; message?: string } {
  if (envelope.from !== envelope.sender_id) {
    return { ok: false, code: "SENDER_ID_MISMATCH", message: "from must equal sender_id" };
  }
  const allowedSenders = options?.acl?.[String(envelope.type)] ?? [];
  if (!allowedSenders.includes(envelope.sender_id)) {
    return { ok: false, code: "ACL_DENY", message: `sender ${envelope.sender_id} cannot publish ${envelope.type}` };
  }
  if (envelope.type === "aggregation_result" && envelope.to !== options.aggregationResultTarget) {
    return { ok: false, code: "INVALID_ROUTE", message: `aggregation_result must target ${options.aggregationResultTarget}` };
  }
  const expectedSignature = signatureForEnvelope(envelope);
  if (envelope.signature !== expectedSignature) {
    return { ok: false, code: "SIGNATURE_INVALID", message: "signature verification failed" };
  }
  if (options.requireTaskIdMatch && options.taskIdMatchTypes.includes(envelope.type)) {
    const payloadTaskId = envelope?.payload?.task_id;
    if (payloadTaskId !== envelope.task_id) {
      return { ok: false, code: "TASK_ID_MISMATCH", message: "envelope.task_id must equal payload.task_id" };
    }
  }
  return { ok: true };
}
