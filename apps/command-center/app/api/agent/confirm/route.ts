import { AgentConfirmRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { evolveContextFromPreviewConfirmation } from "@/lib/agent/conversation-context";
import { confirmSalesOrder } from "@/lib/agent/sales-order-confirmation";
import { getCapabilityGateway } from "@/lib/capabilities";
import { recordAgentStep, withMcpTrace } from "@/lib/observability/mcp-trace";
import { createObservedCapabilityGateway } from "@/lib/observability/observed-gateway";

function capabilityFailureResponse() {
  return NextResponse.json(
    {
      error: "capability_gateway_unavailable",
      message: "Nao consegui confirmar o pedido porque o gateway MCP/banco esta indisponivel. Nenhuma criacao foi aplicada."
    },
    { status: 503 }
  );
}

export async function POST(request: Request) {
  const body = AgentConfirmRequestSchema.parse(await request.json());
  if (body.preview.warnings.length > 0) {
    await recordAgentStep({
      name: "confirmation_blocked.preview_warnings",
      kind: "decision",
      status: "success",
      durationMs: 0,
      outputs: {
        warningCount: body.preview.warnings.length,
        customerId: body.preview.customer.id
      }
    });
    return NextResponse.json(
      {
        error: "Confirmation blocked by preview warnings.",
        warnings: body.preview.warnings
      },
      { status: 409 }
    );
  }

  try {
    const { result: response, trace } = await withMcpTrace(
      {
        name: "agent.confirm_sales_order",
        inputs: {
          customerId: body.preview.customer.id,
          lineCount: body.preview.lines.length,
          createInvoice: body.createInvoice,
          hasConversationContext: Boolean(body.conversationContext)
        },
        tags: ["confirmation"]
      },
      async () => {
        await recordAgentStep({
          name: "user_confirmation_received",
          status: "success",
          durationMs: 0,
          outputs: {
            customerId: body.preview.customer.id,
            lineCount: body.preview.lines.length,
            createInvoice: body.createInvoice
          }
        });
        return confirmSalesOrder(createObservedCapabilityGateway(await getCapabilityGateway(), "confirmation.capability"), body.preview, body.createInvoice);
      }
    );
    return NextResponse.json(AgentResponseSchema.parse({
      ...response,
      mcpTrace: trace,
      conversationContext: evolveContextFromPreviewConfirmation({
        current: body.conversationContext,
        preview: body.preview,
        response
      })
    }));
  } catch (error) {
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
