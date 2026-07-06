import { AgentConfirmRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { confirmSalesOrder } from "@/lib/agent/demo-agent";
import { getCapabilityGateway, getFallbackCapabilityGateway } from "@/lib/capabilities";

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
    const response = await confirmSalesOrder(await getCapabilityGateway(), body.preview, body.createInvoice);
    return NextResponse.json(AgentResponseSchema.parse(response));
  } catch (error) {
    console.error("Confirmation capability gateway failed. Falling back to demo gateway.", error);
    const response = await confirmSalesOrder(getFallbackCapabilityGateway(), body.preview, body.createInvoice);
    return NextResponse.json(AgentResponseSchema.parse({ ...response, mode: "fallback" }));
  }
}
