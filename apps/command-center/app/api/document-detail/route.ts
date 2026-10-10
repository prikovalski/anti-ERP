import type { ConceptInvoice, SalesOrder } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import { getCapabilityGateway, getConversationSessionStore } from "@/lib/capabilities";

/** The opened document becomes the session's active order, so "aplique 10% de desconto" refers to it. */
async function focusSession(sessionId: string | null, order: SalesOrder | null, invoice: ConceptInvoice | null) {
  const sessions = await getConversationSessionStore();
  const session = await sessions.load(sessionId);
  const context = {
    ...session.context,
    activeOrderId: order?.id ?? invoice?.salesOrderId ?? session.context.activeOrderId,
    activeInvoiceId: invoice?.id ?? session.context.activeInvoiceId,
    lastDocumentType: invoice && !order ? "invoice" as const : "sales_order" as const
  };
  await sessions.save({ id: session.id, context });
  return { sessionId: session.id, conversationContext: context };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const id = searchParams.get("id");
  const sessionId = searchParams.get("sessionId");

  if (!id || (type !== "order" && type !== "invoice")) {
    return NextResponse.json(
      { error: "invalid_request", message: "Informe type=order|invoice e id." },
      { status: 400 }
    );
  }

  try {
    const gateway = await getCapabilityGateway();

    if (type === "order") {
      const order = await gateway.getSalesOrder({ salesOrderId: id });
      if (!order) {
        return NextResponse.json({ error: "not_found", message: `Pedido ${id} nao encontrado.` }, { status: 404 });
      }
      const [invoice] = await gateway.listConceptInvoices({ salesOrderId: order.id, take: 1 });
      return NextResponse.json({ order, invoice: invoice ?? null, ...(await focusSession(sessionId, order, invoice ?? null)) });
    }

    const invoice = await gateway.getConceptInvoice({ invoiceId: id });
    if (!invoice) {
      return NextResponse.json({ error: "not_found", message: `Nota fiscal ${id} nao encontrada.` }, { status: 404 });
    }

    const order = await gateway.getSalesOrder({ salesOrderId: invoice.salesOrderId });
    return NextResponse.json({ order, invoice, ...(await focusSession(sessionId, order, invoice)) });
  } catch (error) {
    console.error("Document detail failed.", error);
    return NextResponse.json(
      { error: "document_detail_failed", message: "Nao consegui carregar os detalhes do documento." },
      { status: 503 }
    );
  }
}
