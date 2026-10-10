import type { Classification, Command } from "./commands";
import { asksAnalytics, asksTraditionalFlow, extractAnalytics, isManagerialReportRequest, isVagueReportRequest } from "./analytics";
import { asksToListCustomers, extractCatalogCreate, extractCatalogManagement, extractProductUpdate, inferCatalogStatus } from "./catalog";
import { asksInventoryDiagnostic, extractInventoryCommand } from "./inventory";
import { extractInvoiceCommand } from "./invoices";
import { inferOrderWithLlm } from "./llm";
import {
  asksToListSalesOrders,
  extractCustomerQuery,
  extractDiscount,
  extractOrderCommand,
  extractOrderItemChange,
  extractOrderLines,
  inferOrderListFilters,
  mentionsReservation,
  wantsInvoice
} from "./orders";
import { extractSalesOrderId, mentionsSalesOrder, normalizeText } from "./text";
import { extractWorkflowSteps } from "./workflow";

type Candidate = { command: Command; score: number };
type Detector = (message: string, normalized: string) => Candidate | null;

const LLM_MIN_CONFIDENCE = 0.8;

const INVOICE_SCORES = {
  "invoice.cancel": 0.9,
  "invoice.reissue": 0.9,
  "invoice.get": 0.88,
  "invoice.list": 0.86,
  "invoice.create": 0.85
} as const;

const INVENTORY_SCORES = {
  "inventory.low_stock": 0.88,
  "inventory.writeoff": 0.86,
  "inventory.history": 0.85,
  "inventory.position": 0.84,
  "inventory.move": 0.8
} as const;

/**
 * Every detector proposes a command with a score; the highest score wins and ties go to the earlier detector.
 * A complete order ("pedido para X com N itens") outscores the invoice and inventory words it may contain.
 */
const detectors: Detector[] = [
  function workflow(message) {
    const steps = extractWorkflowSteps(message);
    return steps ? { command: { kind: "workflow", steps }, score: 0.97 } : null;
  },
  function orderItemChange(message) {
    const change = extractOrderItemChange(message);
    return change ? { command: { ...change, salesOrderId: extractSalesOrderId(message) }, score: 0.95 } : null;
  },
  function orderCreate(message, normalized) {
    const lines = extractOrderLines(message);
    if (!mentionsSalesOrder(normalized) && !lines.length) {
      return null;
    }
    const customerQuery = extractCustomerQuery(message);
    return {
      command: {
        kind: "order.create",
        customerQuery,
        lines,
        wantsInvoice: wantsInvoice(message),
        mentionsReservation: mentionsReservation(message)
      },
      score: customerQuery && lines.length ? 0.95 : 0.6
    };
  },
  function catalogCreate(message) {
    const creation = extractCatalogCreate(message);
    return creation ? { command: { kind: "catalog.create", ...creation }, score: 0.94 } : null;
  },
  function productUpdate(message) {
    const update = extractProductUpdate(message);
    if (!update) {
      return null;
    }
    // Stock changes go through the inventory ledger so they leave a movement record.
    const command: Command = update.field === "stock"
      ? { kind: "inventory.move", action: "adjustment", productQuery: update.productQuery, quantity: update.value, salesOrderId: null }
      : { kind: "product.update_price", productQuery: update.productQuery, unitPrice: update.value };
    return { command, score: 0.94 };
  },
  function invoice(message) {
    const command = extractInvoiceCommand(message);
    return command ? { command, score: INVOICE_SCORES[command.kind] } : null;
  },
  function discount(message) {
    const extracted = extractDiscount(message);
    return extracted
      ? { command: { kind: "order.discount", salesOrderId: extractSalesOrderId(message), ...extracted }, score: 0.9 }
      : null;
  },
  function orderCommand(message) {
    const command = extractOrderCommand(message);
    return command ? { command, score: command.kind === "order.get" ? 0.88 : 0.9 } : null;
  },
  function catalogManagement(message) {
    const command = extractCatalogManagement(message);
    if (!command) {
      return null;
    }
    return { command, score: command.kind === "catalog.rename" ? 0.9 : 0.85 };
  },
  function customerList(message) {
    return asksToListCustomers(message)
      ? { command: { kind: "catalog.list", entity: "customer", query: null, status: inferCatalogStatus(message) }, score: 0.85 }
      : null;
  },
  function orderList(message) {
    return asksToListSalesOrders(message)
      ? { command: { kind: "order.list", filters: inferOrderListFilters(message) }, score: 0.86 }
      : null;
  },
  function inventory(message) {
    const command = extractInventoryCommand(message);
    return command ? { command, score: INVENTORY_SCORES[command.kind] } : null;
  },
  function inventoryDiagnostic(message) {
    return asksInventoryDiagnostic(message) ? { command: { kind: "inventory.low_stock", threshold: null }, score: 0.88 } : null;
  },
  function traditionalFlow(message) {
    return asksTraditionalFlow(message) ? { command: { kind: "info.traditional_flow" }, score: 0.95 } : null;
  },
  function intelligentReport(message) {
    return isManagerialReportRequest(message) ? { command: { kind: "report.intelligent", question: message }, score: 0.86 } : null;
  },
  function vagueReport(message) {
    return isVagueReportRequest(message) ? { command: { kind: "report.clarify" }, score: 0.83 } : null;
  },
  function metrics(message) {
    if (!asksAnalytics(message)) {
      return null;
    }
    const analytics = extractAnalytics(message);
    return {
      command: {
        kind: "report.metrics",
        metric: analytics.metric,
        productQuery: analytics.productQueries.length === 1 ? analytics.productQueries[0]! : null,
        productQueries: analytics.productQueries.length ? analytics.productQueries : null,
        customerQuery: analytics.customerQuery,
        dateRange: analytics.dateRange,
        groupBy: analytics.groupBy
      },
      score: 0.82
    };
  },
  function weakOrderList(message, normalized) {
    return /\b(liste|listar|recentes|criados)\b/.test(normalized)
      ? { command: { kind: "order.list", filters: inferOrderListFilters(message) }, score: 0.6 }
      : null;
  }
];

/** Deterministic classification. Exported for tests and for the Studio graph's first node. */
export function classifyWithRules(message: string | null | undefined): Omit<Classification, "source"> {
  const text = message?.trim() ?? "";
  if (!text) {
    return { command: { kind: "unknown" }, confidence: 0.4, candidates: [] };
  }
  const normalized = normalizeText(text);
  const candidates = detectors.flatMap((detect) => detect(text, normalized) ?? []);
  // Stable sort keeps detector order for equal scores.
  const ranked = candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0];
  return {
    command: best?.command ?? { kind: "unknown" },
    confidence: best?.score ?? 0.4,
    candidates: ranked.map((candidate) => ({ kind: candidate.command.kind, score: candidate.score }))
  };
}

/** Classifies a message once. The model is consulted only when the rules found no confident reading. */
export async function classifyCommand(message: string | null | undefined): Promise<Classification> {
  const rules = classifyWithRules(message);
  const needsModel = rules.command.kind === "unknown"
    || (rules.command.kind === "order.create" && rules.confidence < LLM_MIN_CONFIDENCE);
  if (!needsModel || !message?.trim()) {
    return { ...rules, source: "rules" };
  }

  const llm = await inferOrderWithLlm(message);
  if (llm.status === "skipped") {
    return { ...rules, source: "rules" };
  }
  if (llm.status === "ok" && llm.confidence >= LLM_MIN_CONFIDENCE && llm.command.customerQuery && llm.command.lines.length) {
    return {
      command: llm.command,
      confidence: llm.confidence,
      source: "llm",
      candidates: [{ kind: "order.create", score: llm.confidence }, ...rules.candidates]
    };
  }
  return { ...rules, source: "fallback" };
}
