import type { AgentIntent } from "./openrouter";
import {
  extractAnalytics,
  extractCustomerQuery,
  extractFiscalIntent,
  extractOrderLines as extractEntityOrderLines,
  extractProductUpdate,
  inferProductQueries as inferEntityProductQueries,
  parseQuantity,
} from "./entity-extractor";
import { buildLocalExecutionPlan } from "./planner";

const QUANTITY_TOKEN = "\\d+|um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte";

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanCatalogName(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
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

function extractProductUpdateCommand(message: string) {
  return extractProductUpdate(message);
}

function extractOrderCommand(message: string) {
  const normalized = normalize(message);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const mentionsInvoice = extractFiscalIntent(message);
  const orderLines = extractOrderLines(message);

  if (!mentionsOrder && orderLines.length === 0) {
    return null;
  }

  return {
    customerQuery: extractCustomerQuery(message),
    orderLines,
    wantsInvoice: mentionsInvoice
  };
}

function extractOrderLineAdditionCommand(message: string) {
  const normalized = normalize(message);
  if (!/\b(adicione|adicionar|inclua|incluir|coloque|colocar|acrescente|acrescentar)\b/.test(normalized)) {
    return null;
  }
  if (!/\b(pedido|order)\b/.test(normalized)) {
    return null;
  }

  const match = message.match(
    new RegExp(`\\b(?:adicione|adicionar|inclua|incluir|coloque|colocar|acrescente|acrescentar)\\s+(?:(${QUANTITY_TOKEN})\\s+)?(.+?)\\s+(?:no|na|ao|a)\\s+(?:ultimo\\s+|último\\s+)?pedido\\b`, "i")
  );
  if (!match) {
    return null;
  }

  const quantity = parseQuantityWord(match[1] ?? "") ?? 1;
  const productQuery = cleanProductQuery(match[2] ?? "");
  if (!productQuery) {
    return null;
  }

  return {
    productQuery,
    quantity
  };
}

function extractOrderLineQuantityUpdateCommand(message: string) {
  const normalized = normalize(message);
  if (!/\b(altere|alterar|atualize|atualizar|mude|muda|mudar|defina|definir|ajuste|ajustar)\b/.test(normalized)) {
    return null;
  }
  if (!/\b(pedido|order)\b/.test(normalized)) {
    return null;
  }

  const match =
    message.match(
      new RegExp(`\\b(?:altere|alterar|atualize|atualizar|mude|muda|mudar|defina|definir|ajuste|ajustar)\\s+(?:a\\s+)?(?:quantidade\\s+(?:do|da)\\s+)?(.+?)\\s+(?:do|da|no|na)\\s+(?:ultimo\\s+|último\\s+)?pedido\\s+(?:para|pra|por|em)\\s+(${QUANTITY_TOKEN})\\b`, "i")
    )
    ?? message.match(
      new RegExp(`\\b(?:altere|alterar|atualize|atualizar|mude|muda|mudar|defina|definir|ajuste|ajustar)\\s+(.+?)\\s+(?:para|pra|por|em)\\s+(${QUANTITY_TOKEN})\\s+(?:unidades?\\s+)?(?:no|na|do|da)\\s+(?:ultimo\\s+|último\\s+)?pedido\\b`, "i")
    );
  if (!match) {
    return null;
  }

  const productQuery = cleanProductQuery(match[1] ?? "");
  const quantity = parseQuantityWord(match[2] ?? "");
  if (!productQuery || quantity === null) {
    return null;
  }

  return {
    productQuery,
    quantity
  };
}

function extractOrderLineRemovalCommand(message: string) {
  const normalized = normalize(message);
  if (!/\b(remova|remover|retire|retirar|tire|tira|exclua|excluir)\b/.test(normalized)) {
    return null;
  }
  if (!/\b(pedido|order)\b/.test(normalized)) {
    return null;
  }

  const match = message.match(
    /\b(?:remova|remover|retire|retirar|tire|tira|exclua|excluir)\s+(.+?)\s+(?:do|da|no|na)\s+(?:ultimo\s+|último\s+)?pedido\b/i
  );
  if (!match) {
    return null;
  }

  const productQuery = cleanProductQuery(match[1] ?? "");
  if (!productQuery) {
    return null;
  }

  return {
    productQuery,
    quantity: 0
  };
}

function extractOrderLines(message: string) {
  return extractEntityOrderLines(message);
}

function parseQuantityWord(value: string) {
  return parseQuantity(value);
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
  const executionPlan = buildLocalExecutionPlan(message);
  const catalogCommand = extractCatalogCommand(message);
  const productUpdate = extractProductUpdateCommand(message);
  const orderLineQuantityUpdate = extractOrderLineQuantityUpdateCommand(message);
  const orderLineRemoval = extractOrderLineRemovalCommand(message);
  const orderLineAddition = extractOrderLineAdditionCommand(message);
  const orderCommand = extractOrderCommand(message);
  const quantityMatch = normalized.match(/(\d+)\s+(notebook|notebooks|monitor|monitores|teclado|teclados)/);
  const mentionsInvoice = extractFiscalIntent(message);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const asksTraditionalFlow = /\b(tradicional|erp classico|erp tradicional|compar)/.test(normalized);
  const asksList = /\b(liste|listar|recentes|hoje|criados)\b/.test(normalized);
  const asksAnalytics = /\b(quantos|quanto|qual|quais|ranking|vendemos|vendidos|vendeu|venderam|saindo|saida|saiu|comprou|compraram|faturamento|receita|relatorio|resumo|analise|indicadores)\b/.test(normalized);
  const asksInventoryDiagnostic = /\bestoque\s+baixo\b|\bbaixo\s+estoque\b|\breposi[cç]ao\b|\brepor\b|\bacabando\b/.test(normalized);
  const analytics = extractAnalytics(message);
  const analyticsProductQueries = inferProductQueries(normalized);

  if (executionPlan) {
    return {
      intent: "planned_workflow",
      customerQuery: null,
      productQuery: null,
      catalogName: null,
      productUpdate: null,
      quantity: null,
      wantsInvoice: executionPlan.actions.some((action) =>
        action.type === "create_invoice" || (action.type === "prepare_sales_order" && action.wantsInvoice)
      ),
      analytics: null,
      confidence: 0.9
    };
  }

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

  if (orderLineAddition) {
    return {
      intent: "add_item_to_order",
      customerQuery: null,
      productQuery: orderLineAddition.productQuery,
      catalogName: null,
      productUpdate: null,
      quantity: orderLineAddition.quantity,
      orderLines: [orderLineAddition],
      wantsInvoice: false,
      analytics: null,
      confidence: 0.92
    };
  }

  if (orderLineQuantityUpdate) {
    return {
      intent: "set_order_item_quantity",
      customerQuery: null,
      productQuery: orderLineQuantityUpdate.productQuery,
      catalogName: null,
      productUpdate: null,
      quantity: orderLineQuantityUpdate.quantity,
      orderLines: [orderLineQuantityUpdate],
      wantsInvoice: false,
      analytics: null,
      confidence: 0.92
    };
  }

  if (orderLineRemoval) {
    return {
      intent: "remove_item_from_order",
      customerQuery: null,
      productQuery: orderLineRemoval.productQuery,
      catalogName: null,
      productUpdate: null,
      quantity: 0,
      orderLines: [orderLineRemoval],
      wantsInvoice: false,
      analytics: null,
      confidence: 0.92
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

  if (asksInventoryDiagnostic) {
    return {
      intent: "inventory_diagnostic",
      customerQuery: null,
      productQuery: null,
      catalogName: null,
      productUpdate: null,
      quantity: null,
      wantsInvoice: false,
      analytics: null,
      confidence: 0.88
    };
  }

  if (asksAnalytics) {
    return {
      intent: "analytics_query",
      customerQuery: analytics.customerQuery,
      productQuery: analyticsProductQueries.length > 1
        ? null
        : analyticsProductQueries[0] ?? null,
      catalogName: null,
      productUpdate: null,
      quantity: null,
      wantsInvoice: false,
      analytics: {
        metric: analytics.metric,
        groupBy: analytics.groupBy,
        dateRange: analytics.dateRange,
        productQueries: analyticsProductQueries.length ? analyticsProductQueries : null
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

function inferProductQueries(normalized: string) {
  const products = inferEntityProductQueries(normalized);
  if (!/\b(compare|comparar|comparativo|versus|vs\.?|contra|entre)\b/.test(normalized) && products.length < 2) {
    return products.length === 1 ? products : [];
  }
  return products;
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
