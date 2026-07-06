import { AgentRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import type { AgentResponse } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { runDemoAgent, parseIntentLocally } from "@/lib/agent/demo-agent";
import { inferIntentWithOpenRouter } from "@/lib/agent/openrouter";
import { getCapabilityGateway, getFallbackCapabilityGateway } from "@/lib/capabilities";

export async function POST(request: Request) {
  const body = AgentRequestSchema.parse(await request.json());
  let mode: AgentResponse["mode"] = process.env.OPENROUTER_API_KEY ? "openrouter" : "demo-agent";

  try {
    const intent = (await inferIntentWithOpenRouter(body.message)) ?? parseIntentLocally(body.message);
    const response = runDemoAgent({
      message: body.message,
      intent,
      mode,
      gateway: getCapabilityGateway(),
      lastOrderId: body.lastOrderId
    });
    return NextResponse.json(AgentResponseSchema.parse(await response));
  } catch (error) {
    mode = "fallback";
    const response = await runDemoAgent({
      message: body.message,
      intent: parseIntentLocally(body.message),
      mode,
      gateway: getFallbackCapabilityGateway(),
      lastOrderId: body.lastOrderId
    });
    return NextResponse.json(AgentResponseSchema.parse(response));
  }
}
