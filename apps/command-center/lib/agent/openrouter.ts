import { z } from "zod";

const IntentSchema = z.object({
  intent: z.enum([
    "create_order",
    "create_invoice",
    "create_customer",
    "create_product",
    "create_supplier",
    "update_product",
    "create_order_with_invoice",
    "list_orders",
    "traditional_flow",
    "analytics_query",
    "unknown"
  ]),
  customerQuery: z.string().nullable(),
  productQuery: z.string().nullable(),
  catalogName: z.string().nullable().optional(),
  productUpdate: z.object({
    productQuery: z.string().nullable(),
    unitPrice: z.number().nonnegative().nullable(),
    availableStock: z.number().int().nonnegative().nullable()
  }).nullable().optional(),
  quantity: z.number().int().positive().nullable(),
  orderLines: z.array(
    z.object({
      productQuery: z.string(),
      quantity: z.number().int().positive()
    })
  ).nullable().optional(),
  wantsInvoice: z.boolean(),
  analytics: z.object({
    metric: z.enum(["units_sold", "revenue", "order_count"]).nullable(),
    groupBy: z.enum(["product", "customer", "day"]).nullable(),
    dateRange: z.enum(["today", "last_7_days", "month_to_date", "all_time"]).nullable(),
    productQueries: z.array(z.string()).nullable().optional()
  }).nullable(),
  confidence: z.number().min(0).max(1)
});

export type AgentIntent = z.infer<typeof IntentSchema>;

export async function inferIntentWithOpenRouter(message: string): Promise<AgentIntent | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = process.env.OPENROUTER_MODEL ?? "openrouter/free";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-OpenRouter-Title": "anti-ERP"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You classify user intent for an MCP-native ERP demo. Return only compact JSON. Use these exact enum values in English: intent=create_order|create_invoice|create_customer|create_product|create_supplier|update_product|create_order_with_invoice|list_orders|traditional_flow|analytics_query|unknown; analytics.metric=units_sold|revenue|order_count; analytics.groupBy=product|customer|day|null; analytics.dateRange=today|last_7_days|month_to_date|all_time. For 'cadastre o cliente Atlas', use intent=create_customer and catalogName=Atlas. For 'cadastre o produto Mouse', use intent=create_product and catalogName=Mouse. For 'cadastre o fornecedor Delta', use intent=create_supplier and catalogName=Delta. For 'Atualize o preço do produto Mouse para 50 reais', use intent=update_product and productUpdate.productQuery=Mouse and productUpdate.unitPrice=50. For stock updates, set productUpdate.availableStock. For 'crie o pedido e a NF para Maria com 1 mouse e 1 monitor', use intent=create_order_with_invoice, customerQuery=Maria, orderLines=[{productQuery:'mouse',quantity:1},{productQuery:'monitor',quantity:1}], wantsInvoice=true. Never translate enum values. Never execute actions."
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 220
    })
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    return null;
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    return IntentSchema.parse(normalizePlannerPayload(JSON.parse(jsonMatch[0]), message));
  } catch {
    return null;
  }
}

function normalizePlannerPayload(raw: unknown, message: string) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const payload = raw as Record<string, unknown>;
  const analytics =
    payload.analytics && typeof payload.analytics === "object"
      ? { ...(payload.analytics as Record<string, unknown>) }
      : null;

  if (analytics) {
    analytics.metric = mapMetric(analytics.metric);
    analytics.groupBy = mapGroupBy(analytics.groupBy);
    analytics.dateRange = mapDateRange(analytics.dateRange);
    analytics.productQueries = normalizeProductQueries(analytics.productQueries);
  }

  const inferredCatalogName = inferCatalogName(message);
  const inferredProductUpdate = inferProductUpdate(message);
  const inferredOrder = inferOrderRequest(message);
  const inferredAnalytics = inferAnalyticsRequest(message);
  const normalizedAnalytics =
    analytics || inferredAnalytics
      ? {
          metric: inferredAnalytics?.metric ?? analytics?.metric ?? null,
          groupBy: inferredAnalytics?.groupBy ?? analytics?.groupBy ?? null,
          dateRange: inferredAnalytics?.dateRange ?? analytics?.dateRange ?? "all_time",
          productQueries: inferredAnalytics?.productQueries ?? analytics?.productQueries ?? null
        }
      : null;
  const comparisonProductQueries = Array.isArray(normalizedAnalytics?.productQueries)
    ? normalizedAnalytics.productQueries
    : null;

  return {
    ...payload,
    intent: inferredOrder?.wantsInvoice
      ? "create_order_with_invoice"
      : inferredOrder
        ? "create_order"
        : payload.intent,
    customerQuery: inferredOrder?.customerQuery ?? (typeof payload.customerQuery === "string" ? payload.customerQuery : inferCustomerQuery(message)),
    productQuery: inferredProductUpdate?.productQuery
      ?? inferredOrder?.orderLines[0]?.productQuery
      ?? (comparisonProductQueries && comparisonProductQueries.length > 1
        ? null
        : typeof payload.productQuery === "string" ? payload.productQuery : inferProductQuery(message)),
    catalogName: inferredCatalogName ?? (typeof payload.catalogName === "string" ? cleanCatalogName(payload.catalogName) : null),
    productUpdate: inferredProductUpdate ?? normalizeProductUpdate(payload.productUpdate),
    quantity: inferredOrder?.orderLines[0]?.quantity ?? normalizeQuantity(payload.quantity),
    orderLines: inferredOrder?.orderLines ?? normalizeOrderLines(payload.orderLines),
    wantsInvoice: inferredOrder?.wantsInvoice ?? Boolean(payload.wantsInvoice),
    analytics: normalizedAnalytics,
    confidence: normalizeConfidence(payload.confidence)
  };
}

function inferAnalyticsRequest(message: string) {
  const normalized = normalizeText(message);
  const metric = /\b(pedidos|pedido)\b/.test(normalized) && /\b(quantos|quantidade|total)\b/.test(normalized)
    ? "order_count"
    : /\b(faturamento|receita|valor|quanto)\b/.test(normalized) && !/\bquantos\b/.test(normalized)
      ? "revenue"
      : null;
  const groupBy = /\bpor\s+cliente\b|\bclientes\b|\bquais\s+clientes\b/.test(normalized)
    ? "customer"
    : /\bpor\s+produto\b|\bprodutos\b|\branking\b/.test(normalized)
      ? "product"
      : /\bpor\s+dia\b|\bdia\s+a\s+dia\b/.test(normalized)
        ? "day"
        : null;
  const dateRange = normalized.includes("semana")
    ? "last_7_days"
    : normalized.includes("mes")
      ? "month_to_date"
      : normalized.includes("hoje")
        ? "today"
        : null;
  const productQueries = inferProductQueries(message);

  if (!metric && !groupBy && !dateRange && !productQueries.length) {
    return null;
  }

  return {
    metric,
    groupBy,
    dateRange,
    productQueries: productQueries.length ? productQueries : null
  };
}

function inferOrderRequest(message: string) {
  const normalized = normalizeText(message);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const mentionsInvoice = /\b(nota|nf|invoice|fatura)\b/.test(normalized);
  const customerMatch = message.match(/\b(?:para|pra|pro)\s+(.+?)\s+(?:com|contendo|incluindo|de\s+(?=\d)|itens?\b|os\s+itens?\b)/i);
  const lines = inferOrderLines(message);

  if (!mentionsOrder && lines.length === 0) {
    return null;
  }

  return {
    customerQuery: customerMatch ? cleanCustomerQuery(customerMatch[1] ?? "") : inferCustomerQuery(message),
    orderLines: lines,
    wantsInvoice: mentionsInvoice
  };
}

function inferOrderLines(message: string) {
  const segmentMatch =
    message.match(/\b(?:com|contendo|incluindo)\s+(.+)$/i)
    ?? message.match(/\b(?:para|pra|pro)\s+.+?\s+de\s+(\d+.+)$/i);
  if (!segmentMatch) {
    return [];
  }

  const segment = (segmentMatch[1] ?? "")
    .replace(/^(?:os\s+|as\s+)?itens?:?\s*/i, "")
    .replace(/\s+(?:e\s+)?(?:gere|gerar|emita|emitir|crie|criar)\s+(?:a\s+|uma\s+)?(?:nota|nf|invoice|fatura).*$/i, "")
    .replace(/[.!?]+$/g, "");

  const lines: Array<{ productQuery: string; quantity: number }> = [];
  const itemPattern = /(\d+)\s+([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s-]*?)(?=\s*(?:,|\s+e\s+\d+|\s+com\s+\d+|$))/gi;
  for (const match of segment.matchAll(itemPattern)) {
    const quantity = Number(match[1]);
    const productQuery = cleanProductQuery(match[2] ?? "");
    if (Number.isInteger(quantity) && quantity > 0 && productQuery) {
      lines.push({ productQuery, quantity });
    }
  }
  return lines;
}

function cleanProductQuery(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:de|do|da|dos|das|um|uma|o|a|os|as)\s+/i, "")
    .replace(/[.!?]+$/g, "");
}

function normalizeOrderLines(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  const lines = value
    .map((line) => {
      if (!line || typeof line !== "object") {
        return null;
      }
      const payload = line as Record<string, unknown>;
      const productQuery = typeof payload.productQuery === "string" ? cleanProductQuery(payload.productQuery) : "";
      const quantity = normalizeQuantity(payload.quantity);
      return productQuery && quantity ? { productQuery, quantity } : null;
    })
    .filter((line): line is { productQuery: string; quantity: number } => Boolean(line));
  return lines.length ? lines : null;
}

function inferProductUpdate(message: string) {
  const match = message.match(/\b(?:atualize|atualizar|altere|alterar|mude|mudar|defina|definir|ajuste|ajustar)\s+(?:o\s+|a\s+)?(pre[cç]o|valor|estoque)\s+(?:do\s+|da\s+)?produto\s+(.+?)\s+(?:para|pra|por|em)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const field = normalizeText(match[1] ?? "");
  const productQuery = cleanCatalogName(match[2] ?? "");
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

function normalizeProductUpdate(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as Record<string, unknown>;
  return {
    productQuery: typeof payload.productQuery === "string" ? cleanCatalogName(payload.productQuery) : null,
    unitPrice: normalizeOptionalNonNegative(payload.unitPrice),
    availableStock: normalizeOptionalNonNegativeInteger(payload.availableStock)
  };
}

function parsePtNumber(value: string) {
  const cleaned = value
    .replace(/r\$/gi, "")
    .replace(/\breais?\b/gi, "")
    .replace(/\bunidades?\b/gi, "")
    .replace(/[^\d.,-]/g, "")
    .trim();
  if (!cleaned) {
    return null;
  }
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeOptionalNonNegative(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function normalizeOptionalNonNegativeInteger(value: unknown) {
  const numberValue = normalizeOptionalNonNegative(value);
  return numberValue === null ? null : Math.trunc(numberValue);
}

function cleanCatalogName(value: string) {
  const cleaned = value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
  return cleaned || null;
}

function cleanCustomerQuery(value: string) {
  const cleaned = cleanCatalogName(value)?.replace(/^(?:o|a|os|as|um|uma)\s+/i, "") ?? "";
  return cleaned || null;
}

function inferCatalogName(message: string) {
  const match = message.match(/\b(?:cadastre|cadastrar|crie|criar|registre|registrar|adicione|adicionar)\s+(?:o\s+|a\s+|um\s+|uma\s+)?(?:cliente|produto|fornecedor)\s+(.+)$/i);
  return match ? cleanCatalogName(match[1] ?? "") : null;
}

function inferProductQuery(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("monitor")) {
    return "monitor";
  }
  if (normalized.includes("notebook")) {
    return "notebook";
  }
  if (normalized.includes("teclado")) {
    return "teclado";
  }
  return null;
}

function inferProductQueries(message: string) {
  const normalized = normalizeText(message);
  const products = [
    /\bmonitores?\b/.test(normalized) ? "monitor" : null,
    /\bnotebooks?\b/.test(normalized) ? "notebook" : null,
    /\bteclados?\b/.test(normalized) ? "teclado" : null
  ].filter((product): product is string => Boolean(product));

  if (!/\b(compare|comparar|comparativo|versus|vs\.?|contra|entre)\b/.test(normalized) && products.length < 2) {
    return [];
  }
  return products;
}

function normalizeProductQueries(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  const products = value
    .map((product) => typeof product === "string" ? cleanProductQuery(product) : "")
    .filter(Boolean);
  return products.length ? Array.from(new Set(products)) : null;
}

function inferCustomerQuery(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("northstar")) {
    return "northstar";
  }
  if (normalized.includes("globo")) {
    return "globo";
  }
  if (normalized.includes("legacy")) {
    return "legacy";
  }
  return null;
}

function normalizeQuantity(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeConfidence(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.min(1, Math.max(0, numberValue)) : 0.5;
}

function mapMetric(value: unknown) {
  const normalized = String(value ?? "").toLowerCase();
  if (["units_sold", "quantidade_vendida", "unidades_vendidas", "quantity_sold"].includes(normalized)) {
    return "units_sold";
  }
  if (["revenue", "faturamento", "receita", "valor_vendido"].includes(normalized)) {
    return "revenue";
  }
  if (["order_count", "pedidos", "quantidade_pedidos"].includes(normalized)) {
    return "order_count";
  }
  return null;
}

function mapGroupBy(value: unknown) {
  const normalized = String(value ?? "").toLowerCase();
  if (["product", "produto"].includes(normalized)) {
    return "product";
  }
  if (["customer", "cliente"].includes(normalized)) {
    return "customer";
  }
  if (["day", "dia"].includes(normalized)) {
    return "day";
  }
  return null;
}

function mapDateRange(value: unknown) {
  const normalized = String(value ?? "").toLowerCase();
  if (["today", "hoje"].includes(normalized)) {
    return "today";
  }
  if (["last_7_days", "ultimos_7_dias", "últimos_7_dias", "semana"].includes(normalized)) {
    return "last_7_days";
  }
  if (["month_to_date", "mes_atual", "mês_atual"].includes(normalized)) {
    return "month_to_date";
  }
  if (["all_time", "historico", "histórico"].includes(normalized)) {
    return "all_time";
  }
  return null;
}
