import {
  assertPendingActionUsable,
  type PendingActionRecord,
  type PendingActionStore
} from "@anti-erp/capabilities";
import type {
  AgentResponse,
  AuditEvent,
  PendingActionPayload,
  PendingActionSummary,
  SalesOrderPreview
} from "@anti-erp/shared";
import type { CapabilityGateway } from "../capabilities";
import {
  describeOrder,
  formatDiscountError,
  formatInventoryError,
  formatInventoryMovement,
  formatMoney
} from "./agent-messages";
import { confirmSalesOrder } from "./sales-order-confirmation";

/** The write was not attempted because what the user saw no longer matches the current data. */
export class ConfirmationBlockedError extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
    this.name = "ConfirmationBlockedError";
  }
}

export async function proposeAction(
  store: PendingActionStore,
  input: { payload: PendingActionPayload; title: string; summary: string; details?: string[] }
): Promise<PendingActionSummary> {
  const record = await store.create({ payload: input.payload, summary: input.summary });
  return {
    id: record.id,
    kind: input.payload.kind,
    title: input.title,
    summary: input.summary,
    details: input.details ?? [],
    expiresAt: record.expiresAt.toISOString(),
    ...(input.payload.kind === "sales_order.create" ? { createInvoice: input.payload.wantsInvoice } : {})
  };
}

/**
 * Runs a write the user confirmed. The action is re-validated against current data, claimed atomically
 * (a second confirmation of the same id fails) and only then executed.
 */
export async function confirmPendingAction(input: {
  actionId: string;
  /** Overrides the invoice choice the agent read from the message. */
  createInvoice?: boolean;
  gateway: CapabilityGateway;
  store: PendingActionStore;
}): Promise<{ response: AgentResponse; preview: SalesOrderPreview | null }> {
  const record = assertPendingActionUsable(await input.store.get(input.actionId));
  const preview = record.payload.kind === "sales_order.create"
    ? await revalidateSalesOrder(input.gateway, record.payload)
    : null;

  await input.store.claim(record.id);
  try {
    const createInvoice = input.createInvoice ?? (record.payload.kind === "sales_order.create" && record.payload.wantsInvoice);
    const result = await execute(input.gateway, record, createInvoice);
    await input.store.finish(record.id, { status: "completed", resultRef: result.resultRef });
    return { response: result.response, preview };
  } catch (error) {
    await input.store.finish(record.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
    console.error("Confirmed action failed.", { actionId: record.id, kind: record.payload.kind, error });
    return { response: failedResponse(record.payload, error), preview };
  }
}

async function revalidateSalesOrder(
  gateway: CapabilityGateway,
  payload: Extract<PendingActionPayload, { kind: "sales_order.create" }>
) {
  const current = await gateway.prepareSalesOrder({ customerId: payload.customerId, lines: payload.lines });
  if (current.warnings.length) {
    throw new ConfirmationBlockedError(current.warnings);
  }
  if (toCents(current.subtotal) !== toCents(payload.subtotal)) {
    throw new ConfirmationBlockedError([
      `O total mudou de ${formatMoney(payload.subtotal)} para ${formatMoney(current.subtotal)} desde a previa. Peca o pedido novamente para revisar os valores.`
    ]);
  }
  return current;
}

async function execute(
  gateway: CapabilityGateway,
  record: PendingActionRecord,
  createInvoice: boolean
): Promise<{ response: AgentResponse; resultRef: string | null }> {
  const payload = record.payload;
  switch (payload.kind) {
    case "sales_order.create": {
      const response = await confirmSalesOrder(gateway, payload, createInvoice);
      return { response, resultRef: response.order?.id ?? null };
    }
    case "sales_order.cancel": {
      const order = await gateway.cancelSalesOrder({ salesOrderId: payload.salesOrderId });
      return done(await describeCancellation(gateway, order.id), payload, order.id, {
        order,
        lastOrderId: order.id
      });
    }
    case "sales_order.duplicate": {
      const order = await gateway.duplicateSalesOrder({ salesOrderId: payload.salesOrderId });
      return done(`Pedido ${payload.salesOrderId} duplicado como ${order.id}.`, payload, order.id, {
        order,
        lastOrderId: order.id
      });
    }
    case "sales_order.discount": {
      const order = await gateway.applySalesOrderDiscount({
        salesOrderId: payload.salesOrderId,
        productId: payload.productId,
        discountType: payload.discountType,
        value: payload.value
      });
      const label = payload.discountType === "percent" ? `${payload.value}%` : formatMoney(payload.value);
      const scope = payload.productName ? `no item ${payload.productName}` : "no pedido todo";
      return done(`Apliquei desconto de ${label} ${scope}. ${describeOrder(order)}`, payload, order.id, {
        order,
        lastOrderId: order.id
      });
    }
    case "invoice.cancel": {
      const invoice = await gateway.cancelConceptInvoice({ invoiceId: payload.invoiceId });
      return done(`Nota fiscal conceitual ${invoice.id} cancelada.`, payload, invoice.id, {
        invoice,
        lastOrderId: invoice.salesOrderId
      });
    }
    case "invoice.reissue": {
      const invoice = await gateway.reissueConceptInvoice({ invoiceId: payload.invoiceId });
      return done(`Nota fiscal ${payload.invoiceId} reemitida como ${invoice.id}.`, payload, invoice.id, {
        invoice,
        lastOrderId: invoice.salesOrderId
      });
    }
    case "customer.update": {
      const customer = await gateway.updateCustomer({
        customerId: payload.customerId,
        name: payload.name,
        status: payload.status
      });
      const text = payload.name
        ? `Cliente renomeado para ${customer.name}.`
        : `Cliente ${customer.name} ${customer.status === "active" ? "ativado" : "inativado"} com sucesso.`;
      return done(text, payload, customer.id);
    }
    case "supplier.update": {
      const supplier = await gateway.updateSupplier({
        supplierId: payload.supplierId,
        name: payload.name,
        status: payload.status
      });
      const text = payload.name
        ? `Fornecedor renomeado para ${supplier.name}.`
        : `Fornecedor ${supplier.name} ${supplier.status === "active" ? "ativado" : "inativado"} com sucesso.`;
      return done(text, payload, supplier.id);
    }
    case "product.update": {
      const product = await gateway.updateProduct({
        productId: payload.productId,
        name: payload.name,
        unitPrice: payload.unitPrice,
        availableStock: payload.availableStock,
        status: payload.status
      });
      const text = payload.name
        ? `Produto renomeado para ${product.name}.`
        : payload.status
          ? `Produto ${product.name} ${product.status === "active" ? "ativado" : "inativado"} com sucesso.`
          : `Produto ${product.name} atualizado com sucesso.`;
      return done(text, payload, product.id);
    }
    case "inventory.adjust": {
      const movement = await gateway.adjustInventory({
        productId: payload.productId,
        quantity: payload.quantity,
        reason: payload.reason ?? null
      });
      return done(formatInventoryMovement(movement), payload, movement.id);
    }
  }
}

/** Reports what cancellation did to stock and invoices, read back from the ledger instead of assumed. */
async function describeCancellation(gateway: CapabilityGateway, salesOrderId: string) {
  const [releases, writeOffs, issuedInvoices] = await Promise.all([
    gateway.listInventoryMovements({ salesOrderId, type: "reservation_release", take: 100 }),
    gateway.listInventoryMovements({ salesOrderId, type: "order_writeoff", take: 1 }),
    gateway.listConceptInvoices({ salesOrderId, status: "issued", take: 10 })
  ]);
  const parts = [`Pedido ${salesOrderId} cancelado.`];
  if (writeOffs.length) {
    parts.push("O estoque ja tinha sido baixado pela nota fiscal e nao foi devolvido.");
  } else if (releases.length) {
    const units = releases.reduce((sum, movement) => sum + movement.quantity, 0);
    parts.push(`A reserva de ${units} unidade(s) foi liberada.`);
  }
  if (issuedInvoices.length) {
    parts.push(`A nota fiscal ${issuedInvoices.map((invoice) => invoice.id).join(", ")} continua emitida; cancele-a se for o caso.`);
  }
  return parts.join(" ");
}

function done(
  text: string,
  payload: PendingActionPayload,
  resultRef: string,
  extra: Partial<AgentResponse> = {}
): { response: AgentResponse; resultRef: string } {
  return {
    resultRef,
    response: {
      mode: "deterministic",
      message: { id: createId("msg"), role: "agent", text },
      auditEvents: [audit(payload.kind, text)],
      ...extra
    }
  };
}

function failedResponse(payload: PendingActionPayload, error: unknown): AgentResponse {
  const text = payload.kind === "sales_order.discount"
    ? formatDiscountError(error)
    : payload.kind === "inventory.adjust"
      ? formatInventoryError(error)
      : `Nao consegui concluir a operacao confirmada: ${error instanceof Error ? error.message : "erro desconhecido"}`;
  return {
    mode: "deterministic",
    message: { id: createId("msg"), role: "agent", text },
    auditEvents: [audit(`${payload.kind}.failed`, text)]
  };
}

function audit(action: string, summary: string): AuditEvent {
  return {
    id: createId("aud"),
    timestamp: new Date().toISOString(),
    actor: "mcp-tool",
    action,
    summary
  };
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function toCents(value: number) {
  return Math.round(value * 100);
}
