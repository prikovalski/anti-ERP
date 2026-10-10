import type { ConceptInvoiceStatus, ListConceptInvoicesInput } from "@anti-erp/shared";
import type { Command } from "./commands";
import { inferDateRange } from "./dates";
import { extractInvoiceId, extractSalesOrderId, mentionsInvoice, normalizeText } from "./text";

type InvoiceCommand = Extract<Command, { kind: `invoice.${string}` }>;

export function extractInvoiceCommand(message: string): InvoiceCommand | null {
  const normalized = normalizeText(message);
  if (!mentionsInvoice(normalized)) {
    return null;
  }
  const invoiceId = extractInvoiceId(message);
  const salesOrderId = extractSalesOrderId(message);
  if (/\b(cancelar|cancele|cancela|cancelamento)\b/.test(normalized)) {
    return { kind: "invoice.cancel", invoiceId };
  }
  if (/\b(reemitir|reemita|regerar|regere|segunda via|nova nota)\b/.test(normalized)) {
    return { kind: "invoice.reissue", invoiceId };
  }
  if (invoiceId && /\b(consulte|consultar|mostre|mostrar|exiba|exibir|detalhe|detalhes|ver|abra|abrir)\b/.test(normalized)) {
    return { kind: "invoice.get", invoiceId };
  }
  if (/\b(liste|listar|mostre|mostrar|exiba|exibir|quais)\b/.test(normalized) && /\b(notas|nota|nfs|nf|faturas)\b/.test(normalized)) {
    return { kind: "invoice.list", filters: inferInvoiceListFilters(message) };
  }
  if (/\b(emitir|emita|gerar|gere|criar|crie|fature|faturar)\b/.test(normalized)) {
    return { kind: "invoice.create", salesOrderId };
  }
  return null;
}

function inferInvoiceListFilters(message: string): ListConceptInvoicesInput {
  return {
    salesOrderId: extractSalesOrderId(message),
    dateRange: inferDateRange(message),
    status: inferInvoiceStatus(normalizeText(message)),
    take: 25
  };
}

function inferInvoiceStatus(normalized: string): ConceptInvoiceStatus | null {
  if (/\b(cancelada|canceladas|cancelado|cancelados)\b/.test(normalized)) return "canceled";
  if (/\b(reemitida|reemitidas|reemitido|reemitidos|substituida|substituidas)\b/.test(normalized)) return "reissued";
  if (/\b(emitida|emitidas|emitido|emitidos|ativas|ativa)\b/.test(normalized)) return "issued";
  return null;
}
