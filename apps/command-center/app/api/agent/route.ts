import { AgentRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import type { AgentResponse } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { runDemoAgent, parseIntentLocally } from "@/lib/agent/demo-agent";
import { inferIntentWithOpenRouter } from "@/lib/agent/openrouter";

export async function POST(request: Request) {
  const body = AgentRequestSchema.parse(await request.json());
  let mode: AgentResponse["mode"] = process.env.OPENROUTER_API_KEY ? "openrouter" : "demo-agent";

  try {
    const intent = (await inferIntentWithOpenRouter(body.message)) ?? parseIntentLocally(body.message);
    const response = runDemoAgent({
      message: body.message,
      intent,
      mode,
      lastOrderId: body.lastOrderId
    });
    return NextResponse.json(AgentResponseSchema.parse(response));
  } catch (error) {
    mode = "fallback";
    const response = runDemoAgent({
      message: body.message,
      intent: parseIntentLocally(body.message),
      mode,
      lastOrderId: body.lastOrderId
    });
    return NextResponse.json(AgentResponseSchema.parse(response));
  }
}
