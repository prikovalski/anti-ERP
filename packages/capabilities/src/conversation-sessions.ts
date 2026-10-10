import { randomUUID } from "node:crypto";
import { ConversationContextSchema, type ConversationContext } from "@anti-erp/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma-client";

export const CONVERSATION_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORY_SESSIONS = 1000;

export type ConversationSession = { id: string; context: ConversationContext };

export interface ConversationSessionStore {
  /** Returns the session, or a new empty one when the id is missing, unknown or expired. */
  load(id: string | null | undefined): Promise<ConversationSession>;
  save(session: ConversationSession): Promise<void>;
}

function emptyContext(): ConversationContext {
  return ConversationContextSchema.parse({});
}

function newSession(): ConversationSession {
  return { id: `cs_${randomUUID()}`, context: emptyContext() };
}

export class InMemoryConversationSessionStore implements ConversationSessionStore {
  private sessions = new Map<string, { context: ConversationContext; expiresAt: number }>();

  async load(id: string | null | undefined) {
    const stored = id ? this.sessions.get(id) : undefined;
    if (!id || !stored || stored.expiresAt <= Date.now()) {
      return newSession();
    }
    return { id, context: structuredClone(stored.context) };
  }

  async save(session: ConversationSession) {
    this.sessions.delete(session.id);
    this.sessions.set(session.id, {
      context: structuredClone(session.context),
      expiresAt: Date.now() + CONVERSATION_SESSION_TTL_MS
    });
    // Map keeps insertion order, so the first key is the least recently saved session.
    if (this.sessions.size > MAX_MEMORY_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
  }
}

export class PrismaConversationSessionStore implements ConversationSessionStore {
  async load(id: string | null | undefined) {
    if (!id) {
      return newSession();
    }
    const row = await prisma.conversationSession.findUnique({ where: { id } });
    const context = row && row.expiresAt > new Date() ? ConversationContextSchema.safeParse(row.context) : null;
    return context?.success ? { id, context: context.data } : newSession();
  }

  async save(session: ConversationSession) {
    const data = {
      context: session.context as Prisma.InputJsonObject,
      expiresAt: new Date(Date.now() + CONVERSATION_SESSION_TTL_MS)
    };
    await prisma.conversationSession.upsert({
      where: { id: session.id },
      create: { id: session.id, ...data },
      update: data
    });
  }
}
