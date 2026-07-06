import { DemoCapabilityGateway, demoCapabilityGateway } from "./demo-gateway";
import { McpCapabilityGateway } from "./mcp-gateway";
import type { CapabilityGateway } from "./types";

let mcpGateway: CapabilityGateway | null = null;
let prismaGateway: CapabilityGateway | null = null;

export async function getCapabilityGateway(): Promise<CapabilityGateway> {
  if (process.env.CAPABILITY_GATEWAY === "prisma" && process.env.DATABASE_URL) {
    const { PrismaCapabilityGateway } = await import("./prisma-gateway");
    prismaGateway ??= new PrismaCapabilityGateway();
    return prismaGateway;
  }

  if (process.env.CAPABILITY_GATEWAY === "mcp") {
    mcpGateway ??= new McpCapabilityGateway();
    return mcpGateway;
  }

  return demoCapabilityGateway;
}

export function getFallbackCapabilityGateway(): CapabilityGateway {
  return new DemoCapabilityGateway();
}

export type { CapabilityGateway };
