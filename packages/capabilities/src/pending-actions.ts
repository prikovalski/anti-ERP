import { randomUUID } from "node:crypto";
import { PendingActionPayloadSchema, type PendingActionPayload } from "@anti-erp/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma-client";

export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

export type PendingActionStatus = "pending" | "executing" | "completed" | "failed";

export type PendingActionRecord = {
  id: string;
  payload: PendingActionPayload;
  summary: string;
  status: PendingActionStatus;
  resultRef: string | null;
  expiresAt: Date;
  createdAt: Date;
};

export type PendingActionErrorCode = "not_found" | "expired" | "already_used";

export class PendingActionError extends Error {
  constructor(
    readonly code: PendingActionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PendingActionError";
  }
}

export interface PendingActionStore {
  create(input: { payload: PendingActionPayload; summary: string; ttlMs?: number }): Promise<PendingActionRecord>;
  get(id: string): Promise<PendingActionRecord | null>;
  /** Atomically moves a pending, unexpired action to "executing". Only one caller can win. */
  claim(id: string): Promise<PendingActionRecord>;
  finish(id: string, result: { status: "completed" | "failed"; resultRef?: string | null; error?: string | null }): Promise<void>;
}

export function assertPendingActionUsable(record: PendingActionRecord | null, now = new Date()): PendingActionRecord {
  if (!record) {
    throw new PendingActionError("not_found", "Essa confirmacao nao existe mais. Peca a operacao novamente.");
  }
  if (record.status !== "pending") {
    throw new PendingActionError("already_used", "Essa operacao ja foi confirmada. Nada foi executado de novo.");
  }
  if (record.expiresAt <= now) {
    throw new PendingActionError("expired", "Essa confirmacao expirou. Peca a operacao novamente para ver os dados atualizados.");
  }
  return record;
}

function createPendingActionId() {
  return `pa_${randomUUID()}`;
}

export class InMemoryPendingActionStore implements PendingActionStore {
  private records = new Map<string, PendingActionRecord>();

  async create(input: { payload: PendingActionPayload; summary: string; ttlMs?: number }) {
    const createdAt = new Date();
    const record: PendingActionRecord = {
      id: createPendingActionId(),
      payload: PendingActionPayloadSchema.parse(input.payload),
      summary: input.summary,
      status: "pending",
      resultRef: null,
      expiresAt: new Date(createdAt.getTime() + (input.ttlMs ?? PENDING_ACTION_TTL_MS)),
      createdAt
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async get(id: string) {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  async claim(id: string) {
    // No await between the check and the write, so concurrent claims in this process cannot both succeed.
    const record = assertPendingActionUsable(this.records.get(id) ?? null);
    record.status = "executing";
    return { ...record };
  }

  async finish(id: string, result: { status: "completed" | "failed"; resultRef?: string | null }) {
    const record = this.records.get(id);
    if (record) {
      record.status = result.status;
      record.resultRef = result.resultRef ?? null;
    }
  }
}

type DbPendingAction = {
  id: string;
  payload: Prisma.JsonValue;
  summary: string;
  status: string;
  resultRef: string | null;
  expiresAt: Date;
  createdAt: Date;
};

function mapPendingAction(row: DbPendingAction): PendingActionRecord {
  return {
    id: row.id,
    payload: PendingActionPayloadSchema.parse(row.payload),
    summary: row.summary,
    status: row.status as PendingActionStatus,
    resultRef: row.resultRef,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt
  };
}

export class PrismaPendingActionStore implements PendingActionStore {
  async create(input: { payload: PendingActionPayload; summary: string; ttlMs?: number }) {
    const payload = PendingActionPayloadSchema.parse(input.payload);
    const row = await prisma.pendingAction.create({
      data: {
        id: createPendingActionId(),
        kind: payload.kind,
        payload: payload as Prisma.InputJsonObject,
        summary: input.summary,
        expiresAt: new Date(Date.now() + (input.ttlMs ?? PENDING_ACTION_TTL_MS))
      }
    });
    return mapPendingAction(row);
  }

  async get(id: string) {
    const row = await prisma.pendingAction.findUnique({ where: { id } });
    return row ? mapPendingAction(row) : null;
  }

  async claim(id: string) {
    const now = new Date();
    const { count } = await prisma.pendingAction.updateMany({
      where: { id, status: "pending", expiresAt: { gt: now } },
      data: { status: "executing", claimedAt: now }
    });
    if (count !== 1) {
      assertPendingActionUsable(await this.get(id), now);
      throw new PendingActionError("already_used", "Essa operacao ja foi confirmada. Nada foi executado de novo.");
    }
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id } });
    return mapPendingAction(row);
  }

  async finish(id: string, result: { status: "completed" | "failed"; resultRef?: string | null; error?: string | null }) {
    await prisma.pendingAction.update({
      where: { id },
      data: {
        status: result.status,
        resultRef: result.resultRef ?? null,
        error: result.error ?? null,
        finishedAt: new Date()
      }
    });
  }
}
