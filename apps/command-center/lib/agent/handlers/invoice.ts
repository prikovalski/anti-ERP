import { translateDateRange, type ConceptInvoice, type ListConceptInvoicesInput } from "@anti-erp/shared";
import { describeInvoice, formatDate, formatMoney, translateInvoiceStatus } from "../agent-messages";
import type { CommandOf } from "../nlu/commands";
import { audit, proposalResponse, response } from "../responses";
import type { AgentHandler, HandlerContext } from "./types";

type InvoiceCommand = CommandOf<"invoice.create" | "invoice.get" | "invoice.cancel" | "invoice.reissue" | "invoice.list">;

export const invoiceHandler: AgentHandler<InvoiceCommand> = {
  name: "invoice",
  match: (command): command is InvoiceCommand => command.kind.startsWith("invoice."),
  async execute(command, context) {
    switch (command.kind) {
      case "invoice.create":
        return create(command, context);
      case "invoice.list":
        return list(command.filters, context);
      default:
        return byId(command, context);
    }
  }
};

async function create(command: CommandOf<"invoice.create">, { gateway, lastOrderId }: HandlerContext) {
  const salesOrderId = command.salesOrderId ?? lastOrderId;
  if (!salesOrderId) {
    return response("Qual pedido devo usar para emitir a nota fiscal? Informe o numero do pedido.");
  }
  const order = await gateway.getSalesOrder({ salesOrderId });
  if (!order) {
    return response(`Nao encontrei o pedido ${salesOrderId}.`);
  }
  const invoice = await gateway.createConceptInvoice({ salesOrderId: order.id });
  return response(`Nota fiscal conceitual ${invoice.id} emitida para o pedido ${invoice.salesOrderId}, valor ${formatMoney(invoice.amount)}.`, {
    invoice,
    lastOrderId: invoice.salesOrderId,
    auditEvents: [audit("create_concept_invoice", `Nota fiscal emitida: ${invoice.id}.`)]
  });
}

async function byId(command: CommandOf<"invoice.get" | "invoice.cancel" | "invoice.reissue">, { gateway }: HandlerContext) {
  if (!command.invoiceId) {
    return response("Qual nota fiscal devo usar? Informe o numero, por exemplo CI-5001.");
  }
  const invoice = await gateway.getConceptInvoice({ invoiceId: command.invoiceId });
  if (!invoice) {
    return response(`Nao encontrei a nota fiscal ${command.invoiceId}.`);
  }
  if (command.kind === "invoice.get") {
    return response(describeInvoice(invoice), {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("get_concept_invoice", `Nota fiscal consultada: ${invoice.id}.`)]
    });
  }
  if (invoice.status !== "issued") {
    return response(`A nota fiscal ${invoice.id} ja esta ${translateInvoiceStatus(invoice.status)}.`, { invoice, lastOrderId: invoice.salesOrderId });
  }
  if (command.kind === "invoice.cancel") {
    return proposalResponse({
      payload: { kind: "invoice.cancel", invoiceId: invoice.id },
      title: "Cancelar nota fiscal",
      summary: `Cancelar a nota fiscal conceitual ${invoice.id} do pedido ${invoice.salesOrderId} (${invoice.customerName}, ${formatMoney(invoice.amount)}).`,
      extra: { invoice, lastOrderId: invoice.salesOrderId }
    });
  }
  return proposalResponse({
    payload: { kind: "invoice.reissue", invoiceId: invoice.id },
    title: "Reemitir nota fiscal",
    summary: `Reemitir a nota fiscal conceitual ${invoice.id} do pedido ${invoice.salesOrderId}. A nota atual sera substituida.`,
    extra: { invoice, lastOrderId: invoice.salesOrderId }
  });
}

async function list(filters: ListConceptInvoicesInput, { gateway }: HandlerContext) {
  const invoices = await gateway.listConceptInvoices(filters);
  return response(formatInvoiceList(invoices, filters), {
    auditEvents: [audit("list_concept_invoices", `Listadas ${invoices.length} nota(s) fiscal(is).`)]
  });
}

function formatInvoiceList(invoices: ConceptInvoice[], filters: ListConceptInvoicesInput) {
  if (!invoices.length) {
    return "Nao encontrei notas fiscais para esses filtros.";
  }
  const scope = [
    filters.salesOrderId ? `pedido ${filters.salesOrderId}` : null,
    filters.status ? `status ${translateInvoiceStatus(filters.status)}` : null,
    filters.dateRange && filters.dateRange !== "all_time" ? translateDateRange(filters.dateRange) : null
  ].filter(Boolean).join(", ");
  const prefix = scope ? `Encontrei ${invoices.length} nota(s) fiscal(is) para ${scope}` : `Encontrei ${invoices.length} nota(s) fiscal(is)`;
  return `${prefix}: ${invoices
    .slice(0, 8)
    .map((invoice) =>
      `${invoice.id} | emitida em ${formatDate(invoice.issuedAt)} | pedido ${invoice.salesOrderId} | cliente ${invoice.customerName} | status ${translateInvoiceStatus(invoice.status)} | valor ${formatMoney(invoice.amount)} | ${invoice.orderChangedAfterIssue ? "pedido alterado apos emissao" : "pedido sem alteracao"}`
    )
    .join("; ")}.`;
}
