import { AgentRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import type { AgentResponse } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { runDemoAgent, parseIntentLocally } from "@/lib/agent/demo-agent";
import { inferIntentWithOpenRouter } from "@/lib/agent/openrouter";
import { getCapabilityGateway } from "@/lib/capabilities";
import { withMcpTrace } from "@/lib/observability/mcp-trace";

function capabilityFailureResponse() {
  return NextResponse.json(
    {
      error: "capability_gateway_unavailable",
      message: "Nao consegui executar esse comando agora porque o gateway MCP/banco esta indisponivel. Nenhuma escrita foi executada."
    },
    { status: 503 }
  );
}

export async function POST(request: Request) {
  const body = AgentRequestSchema.parse(await request.json());
  let mode: AgentResponse["mode"] = process.env.OPENROUTER_API_KEY ? "openrouter" : "demo-agent";

  try {
    let intent = parseIntentLocally(body.message);
    if (process.env.OPENROUTER_API_KEY) {
      try {
        intent = (await inferIntentWithOpenRouter(body.message)) ?? intent;
      } catch (error) {
        console.error("OpenRouter intent inference failed. Using local parser.", error);
        mode = "demo-agent";
      }
    }
    const { result: response, trace } = await withMcpTrace(async () =>
      runDemoAgent({
        message: body.message,
        intent,
        mode,
        gateway: await getCapabilityGateway(),
        lastOrderId: body.lastOrderId
      })
    );
    return NextResponse.json(AgentResponseSchema.parse({ ...response, mcpTrace: trace }));
  } catch (error) {
    console.error("Agent capability gateway failed. Returning controlled error.", error);
    return capabilityFailureResponse();
  }
}
