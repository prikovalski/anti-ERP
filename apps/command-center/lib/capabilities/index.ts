import {
  InMemoryConversationSessionStore,
  InMemoryPendingActionStore,
  type ConversationSessionStore,
  type PendingActionStore
} from "@anti-erp/capabilities";
import { demoCapabilityGateway } from "./demo-gateway";
import { McpCapabilityGateway } from "./mcp-gateway";
import type { CapabilityGateway } from "./types";

let mcpGateway: CapabilityGateway | null = null;
let prismaGateway: CapabilityGateway | null = null;
let memoryPendingActions: PendingActionStore | null = null;
let prismaPendingActions: PendingActionStore | null = null;
let memorySessions: ConversationSessionStore | null = null;
let prismaSessions: ConversationSessionStore | null = null;

export async function getCapabilityGateway(): Promise<CapabilityGateway> {
  if (process.env.CAPABILITY_GATEWAY === "prisma" && process.env.DATABASE_URL) {
    const { PrismaCapabilityGateway } = await import("./prisma-gateway");
    prismaGateway ??= new PrismaCapabilityGateway();
    return prismaGateway;
  }

  if (process.env.CAPABILITY_GATEWAY === "mcp" && process.env.MCP_STDIO_ENABLED === "true") {
    mcpGateway ??= new McpCapabilityGateway();
    return mcpGateway;
  }

  if ((process.env.CAPABILITY_GATEWAY === "mcp" || process.env.DATABASE_URL) && process.env.CAPABILITY_GATEWAY !== "demo") {
    const { PrismaCapabilityGateway } = await import("./prisma-gateway");
    prismaGateway ??= new PrismaCapabilityGateway();
    return prismaGateway;
  }

  return demoCapabilityGateway;
}

// Confirmations live next to the data they protect: in memory for the demo gateway, in Postgres otherwise.
export async function getPendingActionStore(): Promise<PendingActionStore> {
  const gateway = await getCapabilityGateway();
  if (gateway === demoCapabilityGateway) {
    memoryPendingActions ??= new InMemoryPendingActionStore();
    return memoryPendingActions;
  }
  const { PrismaPendingActionStore } = await import("@anti-erp/capabilities");
  prismaPendingActions ??= new PrismaPendingActionStore();
  return prismaPendingActions;
}

// Conversation memory follows the same rule: in memory for the demo gateway, in Postgres otherwise.
export async function getConversationSessionStore(): Promise<ConversationSessionStore> {
  const gateway = await getCapabilityGateway();
  if (gateway === demoCapabilityGateway) {
    memorySessions ??= new InMemoryConversationSessionStore();
    return memorySessions;
  }
  const { PrismaConversationSessionStore } = await import("@anti-erp/capabilities");
  prismaSessions ??= new PrismaConversationSessionStore();
  return prismaSessions;
}

export type { CapabilityGateway };
