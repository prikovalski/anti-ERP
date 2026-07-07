import { z } from "zod";

const IntentSchema = z.object({
  intent: z.enum([
    "create_order",
    "create_invoice",
    "create_customer",
    "create_product",
    "create_supplier",
    "update_product",
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
  wantsInvoice: z.boolean(),
  analytics: z.object({
    metric: z.enum(["units_sold", "revenue", "order_count"]).nullable(),
    groupBy: z.enum(["product", "customer", "day"]).nullable(),
    dateRange: z.enum(["today", "last_7_days", "month_to_date", "all_time"]).nullable()
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
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
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
            "You classify user intent for an MCP-native ERP demo. Return only compact JSON. Use these exact enum values in English: intent=create_order|create_invoice|create_customer|create_product|create_supplier|update_product|list_orders|traditional_flow|analytics_query|unknown; analytics.metric=units_sold|revenue|order_count; analytics.groupBy=product|customer|day|null; analytics.dateRange=today|last_7_days|month_to_date|all_time. For 'cadastre o cliente Atlas', use intent=create_customer and catalogName=Atlas. For 'cadastre o produto Mouse', use intent=create_product and catalogName=Mouse. For 'cadastre o fornecedor Delta', use intent=create_supplier and catalogName=Delta. For 'Atualize o preço do produto Mouse para 50 reais', use intent=update_product and productUpdate.productQuery=Mouse and productUpdate.unitPrice=50. For stock updates, set productUpdate.availableStock. Never translate enum values. Never execute actions."
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 220
    })
  });

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

  return IntentSchema.parse(normalizePlannerPayload(JSON.parse(jsonMatch[0]), message));
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
  }

  const inferredCatalogName = inferCatalogName(message);
  const inferredProductUpdate = inferProductUpdate(message);

  return {
    ...payload,
    customerQuery: typeof payload.customerQuery === "string" ? payload.customerQuery : inferCustomerQuery(message),
    productQuery: inferredProductUpdate?.productQuery ?? (typeof payload.productQuery === "string" ? payload.productQuery : inferProductQuery(message)),
    catalogName: inferredCatalogName ?? (typeof payload.catalogName === "string" ? cleanCatalogName(payload.catalogName) : null),
    productUpdate: inferredProductUpdate ?? normalizeProductUpdate(payload.productUpdate),
    quantity: normalizeQuantity(payload.quantity),
    wantsInvoice: Boolean(payload.wantsInvoice),
    analytics,
    confidence: normalizeConfidence(payload.confidence)
  };
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
