import type { ListSalesOrdersInput, SalesOrderStatus } from "@anti-erp/shared";
import type { OrderLineRequest } from "./commands";
import { inferDateRange, inferExplicitDatePeriod } from "./dates";
import {
  QUANTITY_TOKEN,
  cleanCatalogQuery,
  cleanEntityName,
  cleanProductQuery,
  extractSalesOrderId,
  mentionsInvoice,
  normalizeText,
  parseDecimal,
  parseQuantity
} from "./text";

// Verbs that start a second instruction after the item list: "... com 2 monitores e gere a nota".
const FOLLOW_UP_VERBS = "gere|gerar|emita|emitir|crie|criar|reserve|reservar|reserva|baixe|baixar|mostre|mostrar|envie|enviar|confirme|confirmar|aplique|aplicar|fature|faturar|cadastre|cadastrar|liste|listar";

export function wantsInvoice(message: string) {
  const normalized = normalizeText(message);
  if (!/\b(nota\s*fiscal|nota|nf-?e?|nfe|danfe|invoice|fatura|faturar|fature)\b/.test(normalized)) {
    return false;
  }
  const negated = /\b(sem|nao|nem)\s+(?:(?:gere|gerar|emita|emitir|precisa|precisar|de|a|o|uma|um|com)\s+)*(nota|nf|nfe|danfe|invoice|fatura|faturar)\b/.test(normalized);
  return !negated;
}

export function mentionsReservation(message: string) {
  return /\b(reserve|reservar|reserva|reservado)\b/.test(normalizeText(message));
}

export function extractCustomerQuery(message: string) {
  const match =
    message.match(/\b(?:para|pra|pro)\s+(.+?)\s+(?:com|contendo|incluindo|de\s+(?=\d|\w+\s+unidade)|itens?\b|os\s+itens?\b)/i)
    ?? message.match(/\b(?:para|pra|pro)\s+(?:o\s+|a\s+)?cliente\s+(.+?)(?=\s+(?:com|de|no|na|hoje|ontem|este|essa|esse|e|sem)\b|[,.!?]?$)/i)
    ?? message.match(/\b(?:para|pra|pro)\s+(.+?)(?=\s+(?:com|de|no|na|hoje|ontem|este|essa|esse|e|sem)\b|[,.!?]?$)/i)
    ?? message.match(/\bcliente\s+(.+?)(?=\s+(?:com|de|no|na|hoje|ontem|este|essa|esse|e|sem)\b|[,.!?]?$)/i);
  return match ? cleanEntityName(match[1] ?? "") || null : null;
}

export function extractOrderLines(message: string): OrderLineRequest[] {
  const segment = extractItemSegment(message);
  if (!segment) {
    return [];
  }

  const lines: OrderLineRequest[] = [];
  const patterns = [
    new RegExp(`(${QUANTITY_TOKEN})\\s+(?:unidades?\\s+de\\s+)?([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\\s-]*?)(?=\\s*(?:,|\\s+e\\s+(?:${QUANTITY_TOKEN})\\b|\\s+com\\s+(?:\\d+|um|uma)\\b|$))`, "gi"),
    new RegExp(`([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\\s-]*?)\\s+(?:x|por|qtd\\.?|quantidade)\\s*(${QUANTITY_TOKEN})(?=\\s*(?:,|\\s+e\\s+|$))`, "gi")
  ];

  for (const pattern of patterns) {
    for (const match of segment.matchAll(pattern)) {
      const first = match[1] ?? "";
      const second = match[2] ?? "";
      const firstIsQuantity = parseQuantity(first) !== null;
      const quantity = firstIsQuantity ? parseQuantity(first) : parseQuantity(second);
      const productQuery = cleanProductQuery(firstIsQuantity ? second : first);
      if (quantity && productQuery && !lines.some((line) => normalizeText(line.productQuery) === normalizeText(productQuery))) {
        lines.push({ productQuery, quantity });
      }
    }
  }
  return lines;
}

function extractItemSegment(message: string) {
  const segmentMatch =
    message.match(/\b(?:com|contendo|incluindo)\s+(.+)$/i)
    ?? message.match(new RegExp(`\\bpedido\\s+de\\s+((?:${QUANTITY_TOKEN}).+?)(?=\\s+(?:para|pra|pro)\\b|[.!?]?$)`, "i"))
    ?? message.match(new RegExp(`\\b(?:para|pra|pro)\\s+.+?\\s+de\\s+((?:${QUANTITY_TOKEN}).+)$`, "i"));
  if (!segmentMatch) {
    return null;
  }
  return (segmentMatch[1] ?? "")
    .replace(/^(?:os\s+|as\s+)?itens?:?\s*/i, "")
    .replace(/\s+(?:para|pra|pro)\s+(?:o\s+|a\s+)?cliente\s+.+$/i, "")
    .replace(/\s+(?:para|pra|pro)\s+[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s-]+$/i, "")
    .replace(new RegExp(`(?:\\s*,)?\\s+(?:e\\s+)?(?:${FOLLOW_UP_VERBS})\\b.*$`, "i"), "")
    // Only negations about the invoice or reservation end the list, so "fone sem fio" stays a product.
    .replace(/(?:\s*,)?\s+(?:e\s+)?(?:sem|nao|não)\s+(?:[A-Za-zÀ-ÿ]+\s+){0,3}?(?:nota|nf|nfe|fatura|invoice|reserva)\b.*$/i, "")
    .replace(/[.!?]+$/g, "");
}

export function extractOrderItemChange(message: string): {
  kind: "order.add_item" | "order.set_item_quantity" | "order.remove_item";
  productQuery: string;
  quantity: number;
} | null {
  const normalized = normalizeText(message);
  if (!/\b(pedido|order)\b/.test(normalized)) {
    return null;
  }

  const addMatch = message.match(
    new RegExp(`\\b(?:adicione|adicionar|inclua|incluir|coloque|colocar|acrescente|acrescentar)\\s+(?:(${QUANTITY_TOKEN})\\s+)?(.+?)\\s+(?:no|na|ao|a)\\s+(?:ultimo\\s+|último\\s+)?pedido\\b`, "i")
  );
  if (addMatch?.[2]) {
    const productQuery = cleanProductQuery(addMatch[2]);
    return productQuery ? { kind: "order.add_item", productQuery, quantity: parseQuantity(addMatch[1]) ?? 1 } : null;
  }

  const setVerbs = "altere|alterar|atualize|atualizar|mude|muda|mudar|defina|definir|ajuste|ajustar";
  const setMatch =
    message.match(new RegExp(`\\b(?:${setVerbs})\\s+(?:a\\s+)?(?:quantidade\\s+(?:do|da)\\s+)?(.+?)\\s+(?:do|da|no|na)\\s+(?:ultimo\\s+|último\\s+)?pedido\\s+(?:para|pra|por|em)\\s+(${QUANTITY_TOKEN})\\b`, "i"))
    ?? message.match(new RegExp(`\\b(?:${setVerbs})\\s+(.+?)\\s+(?:para|pra|por|em)\\s+(${QUANTITY_TOKEN})\\s+(?:unidades?\\s+)?(?:no|na|do|da)\\s+(?:ultimo\\s+|último\\s+)?pedido\\b`, "i"));
  if (setMatch?.[1]) {
    const productQuery = cleanProductQuery(setMatch[1]);
    const quantity = parseQuantity(setMatch[2]);
    return productQuery && quantity !== null ? { kind: "order.set_item_quantity", productQuery, quantity } : null;
  }

  const removeMatch = message.match(
    /\b(?:remova|remover|retire|retirar|tire|tira|exclua|excluir)\s+(.+?)\s+(?:do|da|no|na)\s+(?:ultimo\s+|último\s+)?pedido\b/i
  );
  if (removeMatch?.[1]) {
    const productQuery = cleanProductQuery(removeMatch[1]);
    return productQuery ? { kind: "order.remove_item", productQuery, quantity: 0 } : null;
  }
  return null;
}

export function extractDiscount(message: string): {
  productQuery: string | null;
  discountType: "percent" | "amount";
  value: number;
} | null {
  const normalized = normalizeText(message);
  if (!/\b(desconto|descontar|desconte|abatimento|abater|aplique|aplicar)\b/.test(normalized)) {
    return null;
  }
  if (!/\b(pedido|item|produto|total|todo|inteiro)\b/.test(normalized)) {
    return null;
  }
  const percent = extractDiscountPercent(normalized);
  const amount = percent === null ? extractDiscountAmount(normalized) : null;
  if (percent === null && amount === null) {
    return null;
  }
  return {
    productQuery: extractDiscountProductQuery(message),
    discountType: percent !== null ? "percent" : "amount",
    value: percent ?? amount!
  };
}

function extractDiscountPercent(normalized: string) {
  const match = normalized.match(/\b(\d+(?:[,.]\d+)?)\s*%/) ?? normalized.match(/\b(\d+(?:[,.]\d+)?)\s+por\s+cento\b/);
  return match?.[1] ? parseDecimal(match[1]) : null;
}

function extractDiscountAmount(normalized: string) {
  const match =
    normalized.match(/\b(\d+(?:[,.]\d+)?)\s*(?:reais|real)\b/)
    ?? normalized.match(/\br\$\s*(\d+(?:[,.]\d+)?)/)
    ?? normalized.match(/\bdesconto\s+(?:de\s+)?(\d+(?:[,.]\d+)?)\b/)
    ?? normalized.match(/\b(\d+(?:[,.]\d+)?)\s+(?:de\s+)?desconto\b/);
  return match?.[1] ? parseDecimal(match[1]) : null;
}

function extractDiscountProductQuery(message: string) {
  const normalized = normalizeText(message);
  if (/\bpedido\b/.test(normalized) && !/\b(item|produto)\b/.test(normalized)) {
    return null;
  }
  const productMatch = message.match(/\b(?:item|produto)\s+(.+?)(?=\s+(?:do|da|no|na|em|para|pra)\s+(?:o\s+|a\s+)?pedido|\s+(?:com|de)\s+desconto|[.!?]?$)/i);
  if (productMatch?.[1]) {
    return cleanProductQuery(cleanCatalogQuery(productMatch[1]));
  }
  const itemScopeMatch = message.match(/\b(?:no|na|sobre\s+o|sobre\s+a)\s+(.+?)(?=\s+(?:do|da)\s+(?:pedido|ordem)|\s+(?:com|de)\s+desconto|[.!?]?$)/i);
  if (itemScopeMatch?.[1] && !/\b(pedido|total|todo|inteiro)\b/i.test(itemScopeMatch[1])) {
    return cleanProductQuery(cleanCatalogQuery(itemScopeMatch[1]));
  }
  return null;
}

export function extractOrderCommand(message: string): {
  kind: "order.get" | "order.cancel" | "order.duplicate";
  salesOrderId: string | null;
} | null {
  const normalized = normalizeText(message);
  const salesOrderId = extractSalesOrderId(message);
  // "cancele a nota do pedido" is about the invoice, not the order.
  if (mentionsInvoice(normalized)) {
    return null;
  }
  if (/\b(cancelar|cancele|cancela|cancelamento)\b/.test(normalized) && /\b(pedido|order)\b/.test(normalized)) {
    return { kind: "order.cancel", salesOrderId };
  }
  if (/\b(duplicar|duplique|duplica|copiar|copie)\b/.test(normalized) && /\b(pedido|order)\b/.test(normalized)) {
    return { kind: "order.duplicate", salesOrderId };
  }
  if (salesOrderId && /\b(consulte|consultar|mostre|mostrar|exiba|exibir|detalhe|detalhes|ver|abra|abrir)\b/.test(normalized)) {
    return { kind: "order.get", salesOrderId };
  }
  return null;
}

export function asksToListSalesOrders(message: string) {
  const normalized = normalizeText(message);
  return /\bpedidos\b/.test(normalized) && !/\bclientes\b/.test(normalized);
}

export function inferOrderListFilters(message: string): ListSalesOrdersInput {
  const normalized = normalizeText(message);
  const explicitPeriod = inferExplicitDatePeriod(message);
  return {
    customerQuery: extractOrderCustomerFilter(message),
    dateRange: explicitPeriod ? "all_time" : inferDateRange(message),
    dateFrom: explicitPeriod?.dateFrom ?? null,
    dateTo: explicitPeriod?.dateTo ?? null,
    status: inferOrderStatus(normalized),
    take: 25
  };
}

function inferOrderStatus(normalized: string): SalesOrderStatus | null {
  if (/\b(cancelado|cancelados|cancelada|canceladas)\b/.test(normalized)) return "canceled";
  if (/\b(rascunho|rascunhos|draft)\b/.test(normalized)) return "draft";
  if (/\b(confirmado|confirmados|confirmada|confirmadas|emitido|emitidos)\b/.test(normalized)) return "confirmed";
  return null;
}

function extractOrderCustomerFilter(message: string) {
  const stop = "(?=\\s+(?:hoje|ontem|semana|mes|m[eê]s|confirmad|cancelad|rascunho|status|criados|criadas|recentes)\\b|[.!?]?$)";
  const match = [
    new RegExp(`\\bpedidos?\\s+(?:do|da|de|para|pra)\\s+(?:o\\s+|a\\s+)?(?:cliente\\s+)?(.+?)${stop}`, "i"),
    new RegExp(`\\b(?:cliente|clientes)\\s+(.+?)${stop}`, "i"),
    new RegExp(`\\b(?:para|pra)\\s+(?:o\\s+|a\\s+)?(.+?)${stop}`, "i")
  ].map((pattern) => message.match(pattern)).find((candidate) => candidate?.[1]);
  if (!match?.[1]) {
    return null;
  }
  const value = match[1]
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:o|a|os|as|cliente|clientes)\s+/i, "")
    .replace(/[.!?]+$/g, "");
  const isTemporal = /^(?:(?:ultima|ultimo|ultimas|ultimos|passada|passado|hoje|ontem|semana|mes|dia)(?:\s|$))*(?:\d{1,2}(?:[/-]\d{1,2}(?:[/-]\d{2,4})?)?)?$/.test(normalizeText(value));
  return isTemporal || !value ? null : value;
}
