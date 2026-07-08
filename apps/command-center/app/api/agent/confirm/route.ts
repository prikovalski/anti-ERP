import { AgentConfirmRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { confirmSalesOrder } from "@/lib/agent/demo-agent";
import { getCapabilityGateway } from "@/lib/capabilities";
import { withMcpTrace } from "@/lib/observability/mcp-trace";

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
    return NextResponse.json(
      {
        error: "Confirmation blocked by preview warnings.",
        warnings: body.preview.warnings
      },
      { status: 409 }
    );
  }

  try {
    const { result: response, trace } = await withMcpTrace(async () =>
      confirmSalesOrder(await getCapabilityGateway(), body.preview, body.createInvoice)
    );
    return NextResponse.json(AgentResponseSchema.parse({ ...response, mcpTrace: trace }));
  } catch (error) {
    console.error("Confirmation capability gateway failed. Returning controlled error.", error);
    return capabilityFailureResponse();
  }
}
