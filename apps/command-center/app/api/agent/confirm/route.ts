import { AgentConfirmRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { confirmSalesOrder } from "@/lib/agent/demo-agent";
import { getCapabilityGateway, getFallbackCapabilityGateway } from "@/lib/capabilities";

export async function POST(request: Request) {
  const body = AgentConfirmRequestSchema.parse(await request.json());
  try {
    const response = await confirmSalesOrder(getCapabilityGateway(), body.preview, body.createInvoice);
    return NextResponse.json(AgentResponseSchema.parse(response));
  } catch (error) {
    const response = await confirmSalesOrder(getFallbackCapabilityGateway(), body.preview, body.createInvoice);
    return NextResponse.json(AgentResponseSchema.parse({ ...response, mode: "fallback" }));
  }
}
