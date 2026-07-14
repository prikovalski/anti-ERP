import type {
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric
} from "@anti-erp/shared";

export type ExtractedOrderLine = {
  productQuery: string;
  quantity: number;
};

export type ExtractedProductUpdate = {
  productQuery: string;
  unitPrice: number | null;
  availableStock: number | null;
};

export type ExtractedAnalytics = {
  metric: AnalyticsMetric;
  groupBy: AnalyticsGroupBy | null;
  dateRange: AnalyticsDateRange;
  productQueries: string[] | null;
  customerQuery: string | null;
};

const NUMBER_WORDS = new Map<string, number>([
  ["um", 1],
  ["uma", 1],
  ["dois", 2],
  ["duas", 2],
  ["tres", 3],
  ["três", 3],
  ["quatro", 4],
  ["cinco", 5],
  ["seis", 6],
  ["sete", 7],
  ["oito", 8],
  ["nove", 9],
  ["dez", 10],
  ["onze", 11],
  ["doze", 12],
  ["vinte", 20]
]);

export function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function cleanEntityName(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:de|do|da|dos|das|um|uma|o|a|os|as)\s+/i, "")
    .replace(/[.!?]+$/g, "");
}

export function parseQuantity(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const normalized = normalizeText(value.trim());
  const wordValue = NUMBER_WORDS.get(normalized);
  if (wordValue) {
    return wordValue;
  }
  const leadingWord = normalized.match(/^(um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte)\b/);
  if (leadingWord?.[1]) {
    return NUMBER_WORDS.get(leadingWord[1]) ?? null;
  }
  const parsed = Number(normalized.replace(",", "."));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePtNumber(value: string) {
  const cleaned = value
    .replace(/r\$/gi, "")
    .replace(/\breais?\b/gi, "")
    .replace(/\bunidades?\b/gi, "")
    .replace(/[^\d.,-]/g, "")
    .trim();
  if (!cleaned) {
    return parseQuantity(value);
  }
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function extractFiscalIntent(message: string) {
  return /\b(nota\s*fiscal|nota|nf-?e?|nfe|danfe|invoice|fatura|faturar|fature|emitir\s+nota|emita\s+nota)\b/i.test(message);
}

export function extractCustomerQuery(message: string) {
  const match =
    message.match(/\b(?:para|pra|pro)\s+(.+?)\s+(?:com|contendo|incluindo|de\s+(?=\d|\w+\s+unidade)|itens?\b|os\s+itens?\b)/i)
    ?? message.match(/\bcliente\s+(.+?)(?=\s+(?:com|de|no|na|hoje|ontem|este|essa|esse|,|\.|$))/i);
  return match ? cleanEntityName(match[1] ?? "") : null;
}

export function extractOrderLines(message: string): ExtractedOrderLine[] {
  const segment = extractItemSegment(message);
  if (!segment) {
    return [];
  }

  const lines: ExtractedOrderLine[] = [];
  const patterns = [
    /(\d+|um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte)\s+(?:unidades?\s+de\s+)?([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s-]*?)(?=\s*(?:,|\s+e\s+(?:\d+|um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte)|\s+com\s+(?:\d+|um|uma)|$))/gi,
    /([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s-]*?)\s+(?:x|por|qtd\.?|quantidade)\s*(\d+|um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte)(?=\s*(?:,|\s+e\s+|$))/gi
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

export function extractProductUpdate(message: string): ExtractedProductUpdate | null {
  const match = message.match(/\b(?:atualize|atualizar|altere|alterar|mude|mudar|defina|definir|ajuste|ajustar)\s+(?:o\s+|a\s+)?(pre[cç]o|valor|estoque)\s+(?:do\s+|da\s+)?produto\s+(.+?)\s+(?:para|pra|por|em)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const field = normalizeText(match[1] ?? "");
  const productQuery = cleanEntityName(match[2] ?? "");
  const numberValue = parsePtNumber(match[3] ?? "");
  if (!productQuery || numberValue === null) {
    return null;
  }
  return {
    productQuery,
    unitPrice: field === "estoque" ? null : numberValue,
    availableStock: field === "estoque" ? Math.trunc(numberValue) : null
  };
}

export function extractAnalytics(message: string): ExtractedAnalytics {
  const normalized = normalizeText(message);
  const metric = inferAnalyticsMetric(normalized);
  const productQueries = inferProductQueries(normalized);
  return {
    metric,
    groupBy: inferAnalyticsGroupBy(normalized),
    dateRange: inferDateRange(normalized),
    productQueries: productQueries.length ? productQueries : null,
    customerQuery: inferKnownCustomer(normalized)
  };
}

export function inferDateRange(normalized: string): AnalyticsDateRange {
  if (/\b(ultimos?\s+7|sete\s+dias|semana)\b/.test(normalized)) {
    return "last_7_days";
  }
  if (/\b(mes|mensal|mtd)\b/.test(normalized)) {
    return "month_to_date";
  }
  if (/\b(hoje|dia|diario)\b/.test(normalized)) {
    return "today";
  }
  return "all_time";
}

export function inferProductQueries(normalized: string) {
  const explicit = [
    /\bmonitores?\b/.test(normalized) ? "monitor" : null,
    /\bnotebooks?\b/.test(normalized) ? "notebook" : null,
    /\bteclados?\b/.test(normalized) ? "teclado" : null,
    /\bmouses?\b/.test(normalized) ? "mouse" : null
  ].filter((product): product is string => Boolean(product));
  const productFilter = normalized.match(/\b(?:produto|item)\s+([a-z0-9][a-z0-9\s-]+?)(?=\s+(?:hoje|na\s+semana|no\s+mes|por|para|$))/);
  if (productFilter?.[1]) {
    explicit.push(cleanProductQuery(productFilter[1]));
  }
  return Array.from(new Set(explicit));
}

function extractItemSegment(message: string) {
  const segmentMatch =
    message.match(/\b(?:com|contendo|incluindo)\s+(.+)$/i)
    ?? message.match(/\b(?:para|pra|pro)\s+.+?\s+de\s+((?:\d+|um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte).+)$/i);
  if (!segmentMatch) {
    return null;
  }
  return (segmentMatch[1] ?? "")
    .replace(/^(?:os\s+|as\s+)?itens?:?\s*/i, "")
    .replace(/\s+(?:e\s+)?(?:gere|gerar|emita|emitir|crie|criar)\s+(?:a\s+|uma\s+)?(?:nota|nf|invoice|fatura).*$/i, "")
    .replace(/\s+(?:e\s+)?(?:gere|gerar|crie|criar|mostre|mostrar)\s+(?:um\s+|o\s+)?relat[oó]rio.*$/i, "")
    .replace(/[.!?]+$/g, "");
}

function cleanProductQuery(value: string) {
  return cleanEntityName(value)
    .replace(/\s+(?:unidades?|pcs?|pecas?)$/i, "")
    .trim();
}

function inferAnalyticsMetric(normalized: string): AnalyticsMetric {
  if (/\b(pedidos|pedido)\b/.test(normalized) && /\b(quantos|quantidade|total)\b/.test(normalized)) {
    return "order_count";
  }
  if (/\b(faturamento|receita|valor|quanto|ticket)\b/.test(normalized) && !/\bquantos\b/.test(normalized)) {
    return "revenue";
  }
  return "units_sold";
}

function inferAnalyticsGroupBy(normalized: string): AnalyticsGroupBy | null {
  if (/\b(compare|comparar|comparativo|versus|vs\.?|contra|entre)\b/.test(normalized)) {
    return "product";
  }
  if (/\bpor\s+cliente\b|\bclientes\b|\bquais\s+clientes\b/.test(normalized)) {
    return "customer";
  }
  if (/\bpor\s+produto\b|\bprodutos\b|\branking\b|\bmais\s+(venderam|vendeu|sairam|saiu)\b|\bo\s+que\s+mais\s+saiu\b/.test(normalized)) {
    return "product";
  }
  if (/\bpor\s+dia\b|\bdia\s+a\s+dia\b|\bdiario\b/.test(normalized)) {
    return "day";
  }
  return null;
}

function inferKnownCustomer(normalized: string) {
  if (normalized.includes("northstar")) {
    return "northstar";
  }
  if (normalized.includes("globo")) {
    return "globo";
  }
  if (normalized.includes("legacy")) {
    return "legacy";
  }
  const customerFilter = normalized.match(/\b(?:cliente|para|da|do)\s+([a-z0-9][a-z0-9\s-]+?)(?=\s+(?:hoje|na\s+semana|no\s+mes|por|$))/);
  return customerFilter?.[1] ? cleanEntityName(customerFilter[1]) : null;
}
