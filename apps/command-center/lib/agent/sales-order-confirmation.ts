import type {
  AgentResponse,
  AuditEvent,
  SalesOrderPreview
} from "@anti-erp/shared";
import type { CapabilityGateway } from "../capabilities";

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function audit(action: string, summary: string, actor: AuditEvent["actor"] = "mcp-tool"): AuditEvent {
  return {
    id: createId("aud"),
    timestamp: now(),
    actor,
    action,
    summary
  };
}

export async function confirmSalesOrder(
  gateway: CapabilityGateway,
  preview: SalesOrderPreview,
  createInvoice: boolean
): Promise<AgentResponse> {
  const order = await gateway.createSalesOrder({
    preview,
    confirmedByUser: true
  });
  const invoice = createInvoice
    ? await gateway.createConceptInvoice({ salesOrderId: order.id })
    : null;

  return {
    mode: "langgraph",
    order,
    invoice,
    message: {
      id: createId("msg"),
      role: "agent",
      text: invoice
        ? `Pedido ${order.id} criado e nota conceitual ${invoice.id} gerada. Tudo ficou registrado na timeline.`
        : `Pedido ${order.id} criado. Tudo ficou registrado na timeline.`
    },
    auditEvents: [
      audit("create_sales_order", `Created sales order ${order.id}.`),
      ...(invoice ? [audit("create_concept_invoice", `Generated concept invoice ${invoice.id}.`)] : [])
    ],
    lastOrderId: order.id
  };
}
