import {
  AgentResponse,
  AuditEvent,
  SalesOrderPreview
} from "@anti-erp/shared";
import type { CapabilityGateway } from "@/lib/capabilities";
import type { AgentIntent } from "./openrouter";

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function audit(action: string, summary: string, actor: AuditEvent["actor"] = "mcp-tool"): AuditEvent {
  return {
    id: createId("aud"),
    timestamp: now(),
    actor,
    action,
    summary
  };
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
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

function singularizeProductQuery(value: string) {
  const normalized = normalize(value);
  if (normalized.endsWith("oes")) {
    return value.slice(0, -3) + "ao";
  }
  if (normalized.endsWith("is")) {
    return value.slice(0, -2) + "il";
  }
  if (normalized.endsWith("s") && value.length > 3) {
    return value.slice(0, -1);
  }
  return value;
}

export function parseIntentLocally(message: string): AgentIntent {
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

export async function runDemoAgent(input: {
  message: string;
  intent: AgentIntent;
  mode: AgentResponse["mode"];
  gateway: CapabilityGateway;
  lastOrderId?: string;
}): Promise<AgentResponse> {
  const { gateway, intent, lastOrderId, mode } = input;

  if (intent.intent === "update_product") {
    const update = intent.productUpdate;
    if (!update?.productQuery || (update.unitPrice === null && update.availableStock === null)) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: "Consigo atualizar o produto, mas preciso saber o produto e o novo preço ou estoque."
        },
        auditEvents: [audit("product_update_context_required", "Product update blocked without product or field value.", "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    const matches = await gateway.searchProduct({ query: update.productQuery });
    const product = matches[0] ?? null;
    if (!product) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: `Nao encontrei um produto chamado ${update.productQuery}.`
        },
        auditEvents: [audit("update_product_not_found", `Product ${update.productQuery} was not found.`, "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    const updatedProduct = await gateway.updateProduct({
      productId: product.id,
      unitPrice: update.unitPrice,
      availableStock: update.availableStock
    });
    const changedFields = [
      update.unitPrice !== null ? `preço ${money(updatedProduct.unitPrice)}` : null,
      update.availableStock !== null ? `estoque ${updatedProduct.availableStock}` : null
    ].filter(Boolean);

    return {
      mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Produto ${updatedProduct.name} atualizado: ${changedFields.join(", ")}.`
      },
      auditEvents: [
        audit("search_product", `Matched product ${updatedProduct.name}.`),
        audit("update_product", `Updated product ${updatedProduct.name}.`)
      ],
      lastOrderId: lastOrderId ?? null
    };
  }

  if (intent.intent === "create_customer") {
    if (!intent.catalogName) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: "Consigo cadastrar o cliente, mas preciso do nome."
        },
        auditEvents: [audit("catalog_name_required", "Customer creation blocked without a name.", "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    try {
      const customer = await gateway.createCustomer({ name: intent.catalogName });
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: `Cliente ${customer.name} cadastrado com status ${customer.status}. Cidade: ${customer.city}.`
        },
        auditEvents: [audit("create_customer", `Created customer ${customer.name}.`)],
        lastOrderId: lastOrderId ?? null
      };
    } catch (error) {
      return createCatalogErrorResponse(mode, lastOrderId, error, "cliente");
    }
  }

  if (intent.intent === "create_product") {
    if (!intent.catalogName) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: "Consigo cadastrar o produto, mas preciso do nome."
        },
        auditEvents: [audit("catalog_name_required", "Product creation blocked without a name.", "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    try {
      const product = await gateway.createProduct({ name: intent.catalogName });
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: `Produto ${product.name} cadastrado. Ele ficou com SKU ${product.sku}, preço ${money(product.unitPrice)} e estoque ${product.availableStock}.`
        },
        auditEvents: [audit("create_product", `Created product ${product.name}.`)],
        lastOrderId: lastOrderId ?? null
      };
    } catch (error) {
      return createCatalogErrorResponse(mode, lastOrderId, error, "produto");
    }
  }

  if (intent.intent === "create_supplier") {
    if (!intent.catalogName) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: "Consigo cadastrar o fornecedor, mas preciso do nome."
        },
        auditEvents: [audit("catalog_name_required", "Supplier creation blocked without a name.", "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    try {
      const supplier = await gateway.createSupplier({ name: intent.catalogName });
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: `Fornecedor ${supplier.name} cadastrado com status ${supplier.status}.`
        },
        auditEvents: [audit("create_supplier", `Created supplier ${supplier.name}.`)],
        lastOrderId: lastOrderId ?? null
      };
    } catch (error) {
      return createCatalogErrorResponse(mode, lastOrderId, error, "fornecedor");
    }
  }

  if (intent.intent === "traditional_flow") {
    await gateway.getTraditionalErpFlow();
    return {
      mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text:
          "Em um ERP tradicional voce abriria cadastro, pedido, estoque e faturamento em telas separadas. No anti-ERP, a intencao vira uma sequencia auditavel de capacidades MCP."
      },
      auditEvents: [
        audit("get_traditional_erp_flow", "Compared traditional ERP flow with anti-ERP flow.")
      ],
      lastOrderId: lastOrderId ?? null
    };
  }

  if (intent.intent === "list_orders") {
    const orders = await gateway.listRecentOrders();
    return {
      mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: orders.length
          ? `Encontrei ${orders.length} pedido(s) recentes: ${orders
              .map((order) => `${order.id} para ${order.customer.name}`)
              .join(", ")}.`
          : "Ainda nao ha pedidos confirmados nesta sessao demo."
      },
      auditEvents: [audit("list_recent_orders", "Listed recent sales orders.")],
      lastOrderId: lastOrderId ?? null
    };
  }

  if (intent.intent === "analytics_query") {
    const analytics = intent.analytics ?? {
      metric: "units_sold" as const,
      groupBy: null,
      dateRange: "today" as const
    };
    if (!analytics.metric || !analytics.dateRange) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: "Consigo analisar vendas, mas preciso saber qual métrica ou período você quer consultar."
        },
        auditEvents: [audit("analytics_clarification_required", "Missing analytics metric or date range.", "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    const metric = await gateway.querySalesMetrics({
      metric: analytics.metric,
      productQuery: intent.productQuery,
      customerQuery: intent.customerQuery,
      dateRange: analytics.dateRange,
      groupBy: analytics.groupBy
    });

    return {
      mode,
      analyticsResult: metric,
      message: {
        id: createId("msg"),
        role: "agent",
        text: formatAnalyticsAnswer(metric.metric, metric.value, intent.productQuery, analytics.dateRange)
      },
      auditEvents: [audit("query_sales_metrics", `Queried ${metric.label}.`)],
      lastOrderId: lastOrderId ?? null
    };
  }

  if (intent.intent === "create_invoice") {
    const orderId = lastOrderId;
    const existingOrder = orderId ? await gateway.getSalesOrder({ salesOrderId: orderId }) : null;
    if (!orderId || !existingOrder) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: "Ainda nao tenho um pedido confirmado nesta sessao. Crie e confirme um pedido primeiro; depois eu gero a nota conceitual."
        },
        auditEvents: [audit("create_concept_invoice_blocked", "Invoice creation blocked without an existing order.", "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    const invoice = await gateway.createConceptInvoice({ salesOrderId: orderId });
    return {
      mode,
      invoice,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Nota conceitual ${invoice.id} gerada para o pedido ${orderId}.`
      },
      auditEvents: [audit("create_concept_invoice", `Generated concept invoice ${invoice.id}.`)],
      lastOrderId: orderId
    };
  }

  if (intent.intent === "create_order" || intent.intent === "create_order_with_invoice") {
    const customerMatches = intent.customerQuery
      ? await gateway.searchCustomer({ query: intent.customerQuery })
      : [];
    const customer = customerMatches[0] ?? null;
    const requestedLines =
      intent.orderLines && intent.orderLines.length > 0
        ? intent.orderLines
        : intent.productQuery && intent.quantity
          ? [{ productQuery: intent.productQuery, quantity: intent.quantity }]
          : [];
    const resolvedLines = await Promise.all(
      requestedLines.map(async (line) => {
        const matches = await searchProductWithFallback(gateway, line.productQuery);
        return {
          requested: line,
          product: matches[0] ?? null
        };
      })
    );
    const missingProducts = resolvedLines
      .filter((line) => !line.product)
      .map((line) => line.requested.productQuery);
    const missing = [
      customer ? null : "cliente",
      requestedLines.length ? null : "produto e quantidade",
      ...missingProducts.map((product) => `produto ${product}`)
    ].filter(Boolean);

    if (!customer || requestedLines.length === 0 || missingProducts.length > 0) {
      return {
        mode,
        message: {
          id: createId("msg"),
          role: "agent",
          text: `Consigo preparar o pedido, mas preciso de mais contexto: informe ${missing.join(", ")}.`
        },
        auditEvents: [audit("clarification_required", `Missing fields: ${missing.join(", ")}.`, "agent")],
        lastOrderId: lastOrderId ?? null
      };
    }

    const stockResults = await Promise.all(
      resolvedLines.map((line) =>
        gateway.validateStock({
          productId: line.product!.id,
          quantity: line.requested.quantity
        })
      )
    );
    const preview = await gateway.prepareSalesOrder({
      customerId: customer.id,
      lines: resolvedLines.map((line) => ({
        productId: line.product!.id,
        quantity: line.requested.quantity
      }))
    });
    const itemSummary = preview.lines
      .map((line) => `${line.quantity}x ${line.name}`)
      .join(", ");

    return {
      mode,
      preview,
      message: {
        id: createId("msg"),
        role: "agent",
        text: intent.wantsInvoice
          ? `Encontrei ${customer.name}, localizei ${itemSummary}, validei estoque e preparei uma previa de ${money(preview.subtotal)}. Depois da sua confirmacao, criarei o pedido e a nota conceitual.`
          : `Encontrei ${customer.name}, localizei ${itemSummary}, validei estoque e preparei uma previa de ${money(preview.subtotal)}. Preciso da sua confirmacao antes de criar o pedido.`
      },
      auditEvents: [
        audit("search_customer", `Matched customer ${customer.name}.`),
        audit("search_product", `Matched products: ${preview.lines.map((line) => line.name).join(", ")}.`),
        audit(
          "validate_stock",
          `Validated ${stockResults.length} line(s): ${stockResults
            .map((stock) => `${stock.requested}/${stock.available}`)
            .join(", ")}.`
        ),
        audit("prepare_sales_order", `Prepared preview for ${money(preview.subtotal)}.`)
      ],
      lastOrderId: lastOrderId ?? null
    };
  }

  return {
    mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text:
        "Posso cadastrar clientes, produtos e fornecedores, criar pedidos, gerar nota conceitual para um pedido confirmado, listar pedidos recentes ou comparar com um ERP tradicional."
    },
    auditEvents: [audit("unknown_intent", "Agent could not map the message to a supported MCP capability.", "agent")],
    lastOrderId: lastOrderId ?? null
  };
}

function createCatalogErrorResponse(
  mode: AgentResponse["mode"],
  lastOrderId: string | undefined,
  error: unknown,
  label: "cliente" | "produto" | "fornecedor"
): AgentResponse {
  const duplicate = error instanceof Error && /already exists/i.test(error.message);
  return {
    mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: duplicate
        ? `Nao cadastrei o ${label}: ja existe um registro com esse nome.`
        : `Nao consegui cadastrar o ${label} agora. Nenhuma criacao foi aplicada.`
    },
    auditEvents: [
      audit(
        duplicate ? "catalog_duplicate_blocked" : "catalog_creation_failed",
        duplicate ? `Blocked duplicate ${label} creation.` : `Failed to create ${label}.`,
        "agent"
      )
    ],
    lastOrderId: lastOrderId ?? null
  };
}

async function searchProductWithFallback(gateway: CapabilityGateway, productQuery: string) {
  const matches = await gateway.searchProduct({ query: productQuery });
  if (matches.length > 0) {
    return matches;
  }

  const singular = singularizeProductQuery(productQuery);
  if (singular === productQuery) {
    return matches;
  }
  return gateway.searchProduct({ query: singular });
}

function formatAnalyticsAnswer(
  metric: "units_sold" | "revenue" | "order_count",
  value: number,
  productQuery: string | null,
  dateRange: "today" | "last_7_days" | "month_to_date" | "all_time"
) {
  const period =
    dateRange === "today"
      ? "hoje"
      : dateRange === "last_7_days"
        ? "nos últimos 7 dias"
        : dateRange === "month_to_date"
          ? "neste mês"
          : "no histórico";
  const subject = productQuery ? `${productQuery}` : "vendas";

  if (metric === "revenue") {
    return `O faturamento de ${subject} ${period} foi ${money(value)}.`;
  }
  if (metric === "order_count") {
    return `Foram criados ${value} pedido(s) ${period}.`;
  }
  return `Foram vendidas ${value} unidade(s) de ${subject} ${period}.`;
}

export async function confirmSalesOrder(
  gateway: CapabilityGateway,
  preview: SalesOrderPreview,
  createInvoice: boolean
): Promise<AgentResponse> {
  const order = await gateway.createSalesOrder({
    preview,
    confirmedByUser: true
  });
  const invoice = createInvoice
    ? await gateway.createConceptInvoice({ salesOrderId: order.id })
    : null;

  return {
    mode: "demo-agent",
    order,
    invoice,
    message: {
      id: createId("msg"),
      role: "agent",
      text: invoice
        ? `Pedido ${order.id} criado e nota conceitual ${invoice.id} gerada. Tudo ficou registrado na timeline.`
        : `Pedido ${order.id} criado. Tudo ficou registrado na timeline.`
    },
    auditEvents: [
      audit("create_sales_order", `Created sales order ${order.id}.`),
      ...(invoice ? [audit("create_concept_invoice", `Generated concept invoice ${invoice.id}.`)] : [])
    ],
    lastOrderId: order.id
  };
}
