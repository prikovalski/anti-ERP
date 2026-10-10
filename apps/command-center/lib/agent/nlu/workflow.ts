import type { WorkflowStep } from "./commands";
import { extractCatalogCreations } from "./catalog";
import { extractCustomerQuery, extractOrderLines, wantsInvoice } from "./orders";
import { mentionsInvoice, mentionsSalesOrder, normalizeText } from "./text";

/**
 * Splits a message that asks for several operations ("cadastre o cliente X e crie um pedido...") into ordered steps.
 * Returns null when the message holds a single operation; an order plus its invoice counts as one.
 */
export function extractWorkflowSteps(message: string): WorkflowStep[] | null {
  const normalized = normalizeText(message);
  const steps: WorkflowStep[] = extractCatalogCreations(message).map((creation) =>
    creation.entity === "customer"
      ? { type: "create_customer", name: creation.name }
      : creation.entity === "product"
        ? { type: "create_product", name: creation.name }
        : { type: "create_supplier", name: creation.name }
  );

  const lines = extractOrderLines(message);
  const hasOrder = mentionsSalesOrder(normalized) || lines.length > 0;
  if (hasOrder) {
    steps.push({ type: "prepare_sales_order", customerQuery: extractCustomerQuery(message), lines, wantsInvoice: wantsInvoice(message) });
  } else if (mentionsInvoice(normalized) && wantsInvoice(message)) {
    steps.push({ type: "create_invoice" });
  }
  if (/\b(relatorio|gerencial|resumo|analise|indicadores|ranking|faturamento|vendidos|vendas)\b/.test(normalized)) {
    steps.push({ type: "query_report", question: message });
  }

  return steps.length >= 2 ? steps : null;
}
