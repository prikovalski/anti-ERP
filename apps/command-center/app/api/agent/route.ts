import { AgentRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { runAgentGraph } from "@/lib/agent/agent-graph";
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

  try {
    const { result: response, trace } = await withMcpTrace(
      {
        name: "agent.command",
        inputs: {
          commandLength: body.message.length,
          hasLastOrderId: Boolean(body.lastOrderId)
        },
        tags: ["command"]
      },
      async () => {
        return runAgentGraph({
          message: body.message,
          lastOrderId: body.lastOrderId
        });
      }
    );
    return NextResponse.json(AgentResponseSchema.parse({ ...response, mcpTrace: trace }));
  } catch (error) {
    console.error("Agent capability gateway failed. Returning controlled error.", error);
    return capabilityFailureResponse();
  }
}
