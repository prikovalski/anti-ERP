import { AgentRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { evolveConversationContext } from "@/lib/agent/conversation-context";
import { runDirectAgent } from "@/lib/agent/direct-agent";
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
  const timeoutMs = Number(process.env.AGENT_COMMAND_TIMEOUT_MS ?? 12000);

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
        return withTimeout(
          runDirectAgent({
            message: body.message,
            lastOrderId: body.lastOrderId ?? body.conversationContext?.activeOrderId ?? undefined
          }),
          timeoutMs,
          `Agent command exceeded ${timeoutMs}ms.`
        );
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
