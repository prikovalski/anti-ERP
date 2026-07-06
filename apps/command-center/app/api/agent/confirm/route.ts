import { AgentConfirmRequestSchema, AgentResponseSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { confirmSalesOrder } from "@/lib/agent/demo-agent";

export async function POST(request: Request) {
  const body = AgentConfirmRequestSchema.parse(await request.json());
  const response = confirmSalesOrder(body.preview, body.createInvoice);
  return NextResponse.json(AgentResponseSchema.parse(response));
}
