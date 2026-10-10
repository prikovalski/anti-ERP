import { PendingActionError } from "@anti-erp/capabilities";
import { AgentConfirmRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { evolveContextFromPreviewConfirmation, evolveConversationContext } from "@/lib/agent/conversation-context";
import { ConfirmationBlockedError, confirmPendingAction } from "@/lib/agent/pending-actions";
import { getCapabilityGateway, getConversationSessionStore, getPendingActionStore } from "@/lib/capabilities";
import { recordAgentStep, withMcpTrace } from "@/lib/observability/mcp-trace";
import { createObservedCapabilityGateway } from "@/lib/observability/observed-gateway";

const pendingActionStatus = {
  not_found: 404,
  expired: 410,
  already_used: 409
} as const;

function capabilityFailureResponse() {
  return NextResponse.json(
    {
      error: "capability_gateway_unavailable",
      message: "Nao consegui confirmar a operacao porque o gateway MCP/banco esta indisponivel. Tente novamente."
    },
    { status: 503 }
  );
}

export async function POST(request: Request) {
  const parsed = AgentConfirmRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: "Informe o actionId da operacao a confirmar.", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;

  try {
    const sessions = await getConversationSessionStore();
    const session = await sessions.load(body.sessionId);
    const { result, trace } = await withMcpTrace(
      {
        name: "agent.confirm_action",
        inputs: {
          actionId: body.actionId,
          createInvoice: body.createInvoice ?? null,
          resumedSession: session.id === body.sessionId
        },
        tags: ["confirmation"]
      },
      async () => {
        await recordAgentStep({
          name: "user_confirmation_received",
          status: "success",
          durationMs: 0,
          outputs: { actionId: body.actionId, createInvoice: body.createInvoice ?? null }
        });
        return confirmPendingAction({
          actionId: body.actionId,
          createInvoice: body.createInvoice,
          gateway: createObservedCapabilityGateway(await getCapabilityGateway(), "confirmation.capability"),
          store: await getPendingActionStore()
        });
      }
    );
    const { response, preview } = result;
    const conversationContext = preview
      ? evolveContextFromPreviewConfirmation({ current: session.context, preview, response })
      : evolveConversationContext({ current: session.context, response });
    await sessions.save({ id: session.id, context: conversationContext });
    return NextResponse.json(AgentResponseSchema.parse({ ...response, mcpTrace: trace, sessionId: session.id, conversationContext }));
  } catch (error) {
    if (error instanceof PendingActionError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: pendingActionStatus[error.code] });
    }
    if (error instanceof ConfirmationBlockedError) {
      await recordAgentStep({
        name: "confirmation_blocked",
        kind: "decision",
        status: "success",
        durationMs: 0,
        outputs: { actionId: body.actionId, reasonCount: error.reasons.length }
      });
      return NextResponse.json(
        { error: "confirmation_blocked", message: error.message, warnings: error.reasons },
        { status: 409 }
      );
    }
    console.error("Confirmation capability gateway failed. Returning controlled error.", error);
    await recordAgentStep({
      name: "confirmation_controlled_error",
      kind: "error",
      status: "error",
      durationMs: 0,
      error
    });
    return capabilityFailureResponse();
  }
}
