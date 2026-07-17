import { NextResponse } from "next/server";
import { getCapabilityGateway } from "@/lib/capabilities";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const id = searchParams.get("id");

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
      return NextResponse.json({ order, invoice: invoice ?? null });
    }

    const invoice = await gateway.getConceptInvoice({ invoiceId: id });
    if (!invoice) {
      return NextResponse.json({ error: "not_found", message: `Nota fiscal ${id} nao encontrada.` }, { status: 404 });
    }

    const order = await gateway.getSalesOrder({ salesOrderId: invoice.salesOrderId });
    return NextResponse.json({ order, invoice });
  } catch (error) {
    console.error("Document detail failed.", error);
    return NextResponse.json(
      { error: "document_detail_failed", message: "Nao consegui carregar os detalhes do documento." },
      { status: 503 }
    );
  }
}
