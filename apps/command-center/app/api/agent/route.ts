import { AgentRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent/agent";
import { evolveConversationContext } from "@/lib/agent/conversation-context";
import { getConversationSessionStore } from "@/lib/capabilities";
import { withMcpTrace } from "@/lib/observability/mcp-trace";

function capabilityFailureResponse() {
  return NextResponse.json(
    {
      error: "capability_gateway_unavailable",
      message: "Nao consegui executar esse comando agora porque o gateway MCP/banco esta indisponivel."
    },
    { status: 503 }
  );
}

export async function POST(request: Request) {
  const parsed = AgentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: "Envie uma mensagem de ate 2000 caracteres.", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;
  const timeoutMs = Number(process.env.AGENT_COMMAND_TIMEOUT_MS ?? 12000);

  try {
    const sessions = await getConversationSessionStore();
    const session = await sessions.load(body.sessionId);
    const { result: response, trace } = await withMcpTrace(
      {
        name: "agent.command",
        inputs: {
          commandLength: body.message.length,
          hasActiveOrder: Boolean(session.context.activeOrderId),
          resumedSession: session.id === body.sessionId
        },
        tags: ["command"]
      },
      () => withTimeout(
        runAgent({ message: body.message, lastOrderId: session.context.activeOrderId }),
        timeoutMs,
        `Agent command exceeded ${timeoutMs}ms.`
      )
    );
    const conversationContext = evolveConversationContext({
      current: session.context,
      response,
      userCommand: body.message
    });
    await sessions.save({ id: session.id, context: conversationContext });
    return NextResponse.json(AgentResponseSchema.parse({
      ...response,
      mcpTrace: trace,
      sessionId: session.id,
      conversationContext
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
