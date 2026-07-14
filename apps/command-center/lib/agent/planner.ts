import type {
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  ExecutionPlan
} from "@anti-erp/shared";
import {
  extractAnalytics,
  extractCustomerQuery,
  extractFiscalIntent,
  extractOrderLines as extractEntityOrderLines,
} from "./entity-extractor";

export type PlannedAction =
  | { type: "create_customer"; name: string }
  | { type: "create_product"; name: string }
  | { type: "create_supplier"; name: string }
  | {
      type: "prepare_sales_order";
      customerQuery: string | null;
      lines: Array<{ productQuery: string; quantity: number }>;
      wantsInvoice: boolean;
    }
  | { type: "create_invoice" }
  | {
      type: "query_report";
      metric: AnalyticsMetric;
      dateRange: AnalyticsDateRange;
      groupBy: AnalyticsGroupBy | null;
      productQueries: string[] | null;
      customerQuery: string | null;
    };

export type PlannedWorkflow = {
  summary: string;
  actions: PlannedAction[];
};

export function buildLocalExecutionPlan(message: string | null | undefined): PlannedWorkflow | null {
  if (!message?.trim()) {
    return null;
  }

  const actions: PlannedAction[] = [];
  const customerToCreate = extractCatalogName(message, "cliente");
  const productToCreate = extractCatalogName(message, "produto");
  const supplierToCreate = extractCatalogName(message, "fornecedor");
  const order = extractOrderRequest(message);
  const report = extractReportRequest(message);
  const wantsInvoice = extractFiscalIntent(message);

  if (customerToCreate) {
    actions.push({ type: "create_customer", name: customerToCreate });
  }
  if (productToCreate) {
    actions.push({ type: "create_product", name: productToCreate });
  }
  if (supplierToCreate) {
    actions.push({ type: "create_supplier", name: supplierToCreate });
  }
  if (order) {
    actions.push({
      ...order,
      wantsInvoice: order.wantsInvoice || wantsInvoice
    });
  }
  if (wantsInvoice && !order) {
    actions.push({ type: "create_invoice" });
  }
  if (report) {
    actions.push(report);
  }

  const meaningfulActions = actions.filter((action) => action.type !== "create_invoice" || actions.length > 1);
  if (meaningfulActions.length < 2) {
    return null;
  }

  return {
    summary: `Plano com ${meaningfulActions.length} etapa(s) a partir da solicitacao.`,
    actions: meaningfulActions
  };
}

export function toExecutionPlan(workflow: PlannedWorkflow): ExecutionPlan {
  return {
    summary: workflow.summary,
    steps: workflow.actions.map((action, index) => ({
      id: `plan_step_${index + 1}`,
      action: mapActionToPlanAction(action),
      description: describeAction(action),
      status: "planned",
      detail: null
    }))
  };
}

function extractCatalogName(message: string, kind: "cliente" | "produto" | "fornecedor") {
  const match = message.match(
    new RegExp(`\\b(?:cadastre|cadastrar|crie|criar|registre|registrar)\\s+(?:o\\s+|a\\s+|um\\s+|uma\\s+)?${kind}\\s+(.+?)(?=\\s+e\\s+(?:cadastre|cadastrar|crie|criar|registre|registrar|gere|gerar|emita|emitir|fa[cç]a|prepare|liste|relat[oó]rio|um\\s+pedido|uma\\s+nota|a\\s+nota|o\\s+produto|o\\s+cliente|o\\s+fornecedor)|[,.;]|$)`, "i")
  );
  return match ? cleanName(match[1] ?? "") : null;
}

function extractOrderRequest(message: string): Extract<PlannedAction, { type: "prepare_sales_order" }> | null {
  const normalized = normalize(message);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const lines = extractOrderLines(message);
  if (!mentionsOrder && lines.length === 0) {
    return null;
  }

  return {
    type: "prepare_sales_order",
    customerQuery: extractCustomerQuery(message),
    lines,
    wantsInvoice: extractFiscalIntent(message)
  };
}

function extractOrderLines(message: string) {
  return extractEntityOrderLines(message);
}

function extractReportRequest(message: string): Extract<PlannedAction, { type: "query_report" }> | null {
  const normalized = normalize(message);
  if (!/\b(relatorio|gerencial|resumo|analise|indicadores|ranking|faturamento|vendidos|vendas)\b/.test(normalized)) {
    return null;
  }

  const analytics = extractAnalytics(message);
  return {
    type: "query_report",
    metric: analytics.metric,
    dateRange: analytics.dateRange,
    groupBy: analytics.groupBy,
    productQueries: analytics.productQueries,
    customerQuery: analytics.customerQuery
  };
}

function mapActionToPlanAction(action: PlannedAction): ExecutionPlan["steps"][number]["action"] {
  if (action.type === "prepare_sales_order") {
    return "prepare_sales_order";
  }
  if (action.type === "query_report") {
    return "query_report";
  }
  return action.type;
}

function describeAction(action: PlannedAction) {
  if (action.type === "create_customer") {
    return `Cadastrar cliente ${action.name}`;
  }
  if (action.type === "create_product") {
    return `Cadastrar produto ${action.name}`;
  }
  if (action.type === "create_supplier") {
    return `Cadastrar fornecedor ${action.name}`;
  }
  if (action.type === "prepare_sales_order") {
    const items = action.lines.map((line) => `${line.quantity}x ${line.productQuery}`).join(", ");
    return `Preparar pedido de venda${action.customerQuery ? ` para ${action.customerQuery}` : ""}${items ? ` com ${items}` : ""}`;
  }
  if (action.type === "create_invoice") {
    return "Gerar nota fiscal conceitual";
  }
  return "Gerar relatorio gerencial";
}

function cleanName(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
