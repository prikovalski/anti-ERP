import { AgentRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { evolveConversationContext } from "@/lib/agent/conversation-context";
import { runDirectAgent } from "@/lib/agent/direct-agent";
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
          hasLastOrderId: Boolean(body.lastOrderId ?? body.conversationContext?.activeOrderId),
          hasConversationContext: Boolean(body.conversationContext)
        },
        tags: ["command"]
      },
      async () => {
        return runDirectAgent({
          message: body.message,
          lastOrderId: body.lastOrderId ?? body.conversationContext?.activeOrderId ?? undefined
        });
      }
    );
    return NextResponse.json(AgentResponseSchema.parse({
      ...response,
      mcpTrace: trace,
      conversationContext: evolveConversationContext({
        current: body.conversationContext,
        response,
        userCommand: body.message
      })
    }));
  } catch (error) {
    console.error("Agent capability gateway failed. Returning controlled error.", error);
    return capabilityFailureResponse();
  }
}
