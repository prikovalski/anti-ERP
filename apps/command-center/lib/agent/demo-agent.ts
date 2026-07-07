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

export function parseIntentLocally(message: string): AgentIntent {
  const normalized = normalize(message);
  const quantityMatch = normalized.match(/(\d+)\s+(notebook|notebooks|monitor|monitores|teclado|teclados)/);
  const mentionsInvoice = /\b(nota|invoice|fatura)\b/.test(normalized);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const asksTraditionalFlow = /\b(tradicional|erp classico|erp tradicional|compar)/.test(normalized);
  const asksList = /\b(liste|listar|recentes|hoje|criados)\b/.test(normalized);
  const asksAnalytics = /\b(quantos|quanto|vendemos|vendidos|vendeu|saindo|saida|comprou|compraram|faturamento|receita)\b/.test(normalized);
  const dateRange = normalized.includes("semana")
    ? "last_7_days"
    : normalized.includes("mes")
      ? "month_to_date"
      : normalized.includes("hoje")
        ? "today"
        : "all_time";

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
      quantity: null,
      wantsInvoice: false,
      analytics: {
        metric: /\b(quanto|faturamento|receita|vendemos)\b/.test(normalized) && !/\bquantos\b/.test(normalized)
          ? "revenue"
          : /\b(pedidos|pedido)\b/.test(normalized)
            ? "order_count"
            : "units_sold",
        groupBy: normalized.includes("produto")
          ? "product"
          : normalized.includes("cliente")
            ? "customer"
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

  if (intent.intent === "create_order") {
    const customerMatches = intent.customerQuery
      ? await gateway.searchCustomer({ query: intent.customerQuery })
      : [];
    const productMatches = intent.productQuery
      ? await gateway.searchProduct({ query: intent.productQuery })
      : [];
    const customer = customerMatches[0] ?? null;
    const product = productMatches[0] ?? null;
    const quantity = intent.quantity;
    const missing = [
      customer ? null : "cliente",
      product ? null : "produto",
      quantity ? null : "quantidade"
    ].filter(Boolean);

    if (!customer || !product || !quantity) {
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

    const stock = await gateway.validateStock({ productId: product.id, quantity });
    const preview = await gateway.prepareSalesOrder({
      customerId: customer.id,
      lines: [{ productId: product.id, quantity }]
    });

    return {
      mode,
      preview,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Encontrei ${customer.name}, localizei ${product.name}, validei estoque e preparei uma previa de ${money(preview.subtotal)}. Preciso da sua confirmacao antes de criar o pedido.`
      },
      auditEvents: [
        audit("search_customer", `Matched customer ${customer.name}.`),
        audit("search_product", `Matched product ${product.name}.`),
        audit("validate_stock", `Validated ${quantity} units against ${stock.available} in stock.`),
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
        "Posso criar pedidos, gerar nota conceitual para um pedido confirmado, listar pedidos recentes ou comparar com um ERP tradicional."
    },
    auditEvents: [audit("unknown_intent", "Agent could not map the message to a supported MCP capability.", "agent")],
    lastOrderId: lastOrderId ?? null
  };
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
