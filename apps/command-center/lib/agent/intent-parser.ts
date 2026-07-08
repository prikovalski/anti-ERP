import type { AgentIntent } from "./openrouter";

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanCatalogName(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
}

function cleanCustomerQuery(value: string) {
  return cleanCatalogName(value).replace(/^(?:o|a|os|as|um|uma)\s+/i, "");
}

function extractCatalogCommand(message: string) {
  const match = message.match(/\b(?:cadastre|cadastrar|crie|criar|registre|registrar|adicione|adicionar)\s+(?:o\s+|a\s+|um\s+|uma\s+)?(cliente|produto|fornecedor)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const kind = match[1] ?? "";
  const name = match[2] ?? "";
  const normalizedKind = normalize(kind);
  return {
    kind: normalizedKind === "fornecedor" ? "supplier" : normalizedKind === "cliente" ? "customer" : "product",
    name: cleanCatalogName(name)
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

function extractProductUpdateCommand(message: string) {
  const match = message.match(/\b(?:atualize|atualizar|altere|alterar|mude|mudar|defina|definir|ajuste|ajustar)\s+(?:o\s+|a\s+)?(pre[cç]o|valor|estoque)\s+(?:do\s+|da\s+)?produto\s+(.+?)\s+(?:para|pra|por|em)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const field = normalize(match[1] ?? "");
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

function extractOrderCommand(message: string) {
  const normalized = normalize(message);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const mentionsInvoice = /\b(nota|nf|invoice|fatura)\b/.test(normalized);
  const customerMatch = message.match(/\b(?:para|pra|pro)\s+(.+?)\s+(?:com|contendo|incluindo|de\s+(?=\d)|itens?\b|os\s+itens?\b)/i);
  const orderLines = extractOrderLines(message);

  if (!mentionsOrder && orderLines.length === 0) {
    return null;
  }

  return {
    customerQuery: customerMatch ? cleanCustomerQuery(customerMatch[1] ?? "") : null,
    orderLines,
    wantsInvoice: mentionsInvoice
  };
}

function extractOrderLines(message: string) {
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

export function parseIntentLocally(message: string | null | undefined): AgentIntent {
  if (!message?.trim()) {
    return createUnknownIntent();
  }

  const normalized = normalize(message);
  const catalogCommand = extractCatalogCommand(message);
  const productUpdate = extractProductUpdateCommand(message);
  const orderCommand = extractOrderCommand(message);
  const quantityMatch = normalized.match(/(\d+)\s+(notebook|notebooks|monitor|monitores|teclado|teclados)/);
  const mentionsInvoice = /\b(nota|invoice|fatura)\b/.test(normalized);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const asksTraditionalFlow = /\b(tradicional|erp classico|erp tradicional|compar)/.test(normalized);
  const asksList = /\b(liste|listar|recentes|hoje|criados)\b/.test(normalized);
  const asksAnalytics = /\b(quantos|quanto|qual|ranking|vendemos|vendidos|vendeu|saindo|saida|comprou|compraram|faturamento|receita)\b/.test(normalized);
  const dateRange = normalized.includes("semana")
    ? "last_7_days"
    : normalized.includes("mes")
      ? "month_to_date"
      : normalized.includes("hoje")
        ? "today"
        : "all_time";

  if (productUpdate) {
    return {
      intent: "update_product",
      customerQuery: null,
      productQuery: productUpdate.productQuery,
      catalogName: null,
      productUpdate,
      quantity: null,
      wantsInvoice: false,
      analytics: null,
      confidence: 0.94
    };
  }

  if (catalogCommand?.name) {
    return {
      intent:
        catalogCommand.kind === "supplier"
          ? "create_supplier"
          : catalogCommand.kind === "customer"
            ? "create_customer"
            : "create_product",
      customerQuery: null,
      productQuery: catalogCommand.kind === "product" ? catalogCommand.name : null,
      catalogName: catalogCommand.name,
      productUpdate: null,
      quantity: null,
      wantsInvoice: false,
      analytics: null,
      confidence: 0.94
    };
  }

  if (orderCommand) {
    const firstLine = orderCommand.orderLines[0] ?? null;
    return {
      intent: orderCommand.wantsInvoice ? "create_order_with_invoice" : "create_order",
      customerQuery: orderCommand.customerQuery
        ?? (normalized.includes("globo")
          ? "globo"
          : normalized.includes("legacy")
            ? "legacy"
            : normalized.includes("northstar")
              ? "northstar"
              : null),
      productQuery: firstLine?.productQuery ?? null,
      catalogName: null,
      productUpdate: null,
      quantity: firstLine?.quantity ?? null,
      orderLines: orderCommand.orderLines.length ? orderCommand.orderLines : null,
      wantsInvoice: orderCommand.wantsInvoice,
      analytics: null,
      confidence: 0.9
    };
  }

  if (asksAnalytics) {
    return {
      intent: "analytics_query",
      customerQuery: normalized.includes("globo")
        ? "globo"
        : normalized.includes("legacy")
          ? "legacy"
          : normalized.includes("northstar")
            ? "northstar"
            : null,
      productQuery: normalized.includes("monitor")
        ? "monitor"
        : normalized.includes("teclado")
          ? "teclado"
          : normalized.includes("notebook")
            ? "notebook"
            : null,
      catalogName: null,
      productUpdate: null,
      quantity: null,
      wantsInvoice: false,
      analytics: {
        metric: /\b(quanto|faturamento|receita|vendemos|comprou|compraram)\b/.test(normalized) && !/\bquantos\b/.test(normalized)
          ? "revenue"
          : /\b(pedidos|pedido)\b/.test(normalized)
            ? "order_count"
            : "units_sold",
        groupBy: normalized.includes("produto") || normalized.includes("produtos")
          ? "product"
          : normalized.includes("cliente") || normalized.includes("clientes")
            ? "customer"
            : normalized.includes("dia")
              ? "day"
              : null,
        dateRange
      },
      confidence: 0.82
    };
  }

  if (asksTraditionalFlow) {
    return {
      intent: "traditional_flow",
      customerQuery: null,
      productQuery: null,
      catalogName: null,
      productUpdate: null,
      quantity: null,
      wantsInvoice: false,
      analytics: null,
      confidence: 0.95
    };
  }

  if (asksList) {
    return {
      intent: "list_orders",
      customerQuery: null,
      productQuery: null,
      catalogName: null,
      productUpdate: null,
      quantity: null,
      wantsInvoice: false,
      analytics: null,
      confidence: 0.85
    };
  }

  if (mentionsInvoice && !mentionsOrder && !quantityMatch) {
    return {
      intent: "create_invoice",
      customerQuery: null,
      productQuery: null,
      catalogName: null,
      productUpdate: null,
      quantity: null,
      wantsInvoice: true,
      analytics: null,
      confidence: 0.8
    };
  }

  if (mentionsOrder || quantityMatch) {
    return {
      intent: "create_order",
      customerQuery: normalized.includes("globo")
        ? "globo"
        : normalized.includes("legacy")
          ? "legacy"
          : normalized.includes("northstar")
            ? "northstar"
            : null,
      productQuery: normalized.includes("monitor")
        ? "monitor"
        : normalized.includes("teclado")
          ? "teclado"
          : normalized.includes("notebook")
            ? "notebook"
            : null,
      catalogName: null,
      productUpdate: null,
      quantity: quantityMatch ? Number(quantityMatch[1]) : null,
      wantsInvoice: mentionsInvoice,
      analytics: null,
      confidence: 0.86
    };
  }

  return {
    ...createUnknownIntent(),
    confidence: 0.4
  };
}

function createUnknownIntent(): AgentIntent {
  return {
    intent: "unknown",
    customerQuery: null,
    productQuery: null,
    catalogName: null,
    productUpdate: null,
    quantity: null,
    wantsInvoice: false,
    analytics: null,
    confidence: 0.4
  };
}
