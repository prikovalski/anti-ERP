import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type {
  AgentResponse,
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  AnalyticsResult,
  AuditEvent,
  Customer,
  Product,
  SalesOrderPreview
} from "@anti-erp/shared";
import { getCapabilityGateway, type CapabilityGateway } from "../capabilities";
import { recordAgentStep } from "../observability/mcp-trace";
import { parseIntentLocally, runDemoAgent } from "./demo-agent";
import { inferIntentWithOpenRouter, type AgentIntent } from "./openrouter";

type AgentGraphInput = {
  message: string;
  lastOrderId?: string;
};

type AgentRoute = "sales_order" | "analytics" | "legacy";

type AnalyticsQuery = {
  metric: AnalyticsMetric;
  productQuery: string | null;
  customerQuery: string | null;
  dateRange: AnalyticsDateRange;
  groupBy: AnalyticsGroupBy | null;
};

type RequestedOrderLine = {
  productQuery: string;
  quantity: number;
};

type ResolvedOrderLine = {
  requested: RequestedOrderLine;
  product: Product | null;
};

type StockResult = {
  productId: string;
  requested: number;
  available: number;
  valid: boolean;
};

const AgentGraphState = Annotation.Root({
  message: Annotation<string>,
  lastOrderId: Annotation<string | undefined>,
  mode: Annotation<AgentResponse["mode"]>,
  intent: Annotation<AgentIntent | null>,
  gateway: Annotation<CapabilityGateway | null>,
  route: Annotation<AgentRoute | null>,
  customer: Annotation<Customer | null>,
  requestedLines: Annotation<RequestedOrderLine[]>,
  resolvedLines: Annotation<ResolvedOrderLine[]>,
  stockResults: Annotation<StockResult[]>,
  preview: Annotation<SalesOrderPreview | null>,
  analyticsQuery: Annotation<AnalyticsQuery | null>,
  analyticsResult: Annotation<AnalyticsResult | null>,
  response: Annotation<AgentResponse | null>
});

export const antiErpAgentGraph = new StateGraph(AgentGraphState)
  .addNode("parse_local_intent", parseLocalIntentNode)
  .addNode("infer_openrouter_intent", inferOpenRouterIntentNode)
  .addNode("load_capability_gateway", loadCapabilityGatewayNode)
  .addNode("route_intent", routeIntentNode)
  .addNode("resolve_customer", resolveCustomerNode)
  .addNode("resolve_products", resolveProductsNode)
  .addNode("validate_stock", validateStockNode)
  .addNode("prepare_sales_order", prepareSalesOrderNode)
  .addNode("compose_sales_order_response", composeSalesOrderResponseNode)
  .addNode("build_analytics_query", buildAnalyticsQueryNode)
  .addNode("run_analytics_query", runAnalyticsQueryNode)
  .addNode("compose_analytics_response", composeAnalyticsResponseNode)
  .addNode("execute_legacy_plan", executeLegacyPlanNode)
  .addEdge(START, "parse_local_intent")
  .addEdge("parse_local_intent", "infer_openrouter_intent")
  .addEdge("infer_openrouter_intent", "load_capability_gateway")
  .addEdge("load_capability_gateway", "route_intent")
  .addConditionalEdges("route_intent", pickIntentRoute, {
    sales_order: "resolve_customer",
    analytics: "build_analytics_query",
    legacy: "execute_legacy_plan"
  })
  .addEdge("resolve_customer", "resolve_products")
  .addConditionalEdges("resolve_products", pickSalesOrderReadiness, {
    ready: "validate_stock",
    needs_context: "compose_sales_order_response"
  })
  .addEdge("validate_stock", "prepare_sales_order")
  .addEdge("prepare_sales_order", "compose_sales_order_response")
  .addEdge("compose_sales_order_response", END)
  .addConditionalEdges("build_analytics_query", pickAnalyticsReadiness, {
    ready: "run_analytics_query",
    needs_context: "compose_analytics_response"
  })
  .addEdge("run_analytics_query", "compose_analytics_response")
  .addEdge("compose_analytics_response", END)
  .addEdge("execute_legacy_plan", END)
  .compile();

export async function runAgentGraph(input: AgentGraphInput) {
  const result = await antiErpAgentGraph.invoke({
    message: input.message,
    lastOrderId: input.lastOrderId,
    mode: process.env.OPENROUTER_API_KEY ? "openrouter" : "demo-agent",
    intent: null,
    gateway: null,
    route: null,
    customer: null,
    requestedLines: [],
    resolvedLines: [],
    stockResults: [],
    preview: null,
    analyticsQuery: null,
    analyticsResult: null,
    response: null
  });

  if (!result.response) {
    throw new Error("Agent graph completed without a response.");
  }
  return result.response;
}

async function parseLocalIntentNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const intent = parseIntentLocally(state.message);
  await recordAgentStep({
    name: "parse_local_intent",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      intent: intent.intent,
      confidence: intent.confidence
    }
  });

  return {
    intent
  };
}

async function inferOpenRouterIntentNode(state: typeof AgentGraphState.State) {
  if (!process.env.OPENROUTER_API_KEY) {
    return {
      mode: "demo-agent" satisfies AgentResponse["mode"]
    };
  }

  const startedAt = performance.now();
  try {
    const remoteIntent = await inferIntentWithOpenRouter(state.message);
    const intent = remoteIntent ?? state.intent;
    await recordAgentStep({
      name: "infer_openrouter_intent",
      status: "success",
      durationMs: performance.now() - startedAt,
      outputs: {
        usedRemoteIntent: Boolean(remoteIntent),
        intent: intent?.intent,
        confidence: intent?.confidence
      }
    });

    return {
      intent,
      mode: "openrouter" satisfies AgentResponse["mode"]
    };
  } catch (error) {
    console.error("OpenRouter intent inference failed. Using local parser.", error);
    await recordAgentStep({
      name: "infer_openrouter_intent",
      status: "error",
      durationMs: performance.now() - startedAt,
      error
    });
    return {
      mode: "demo-agent" satisfies AgentResponse["mode"]
    };
  }
}

async function loadCapabilityGatewayNode() {
  const startedAt = performance.now();
  const gateway = await getCapabilityGateway();
  await recordAgentStep({
    name: "load_capability_gateway",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      gateway: gateway.constructor.name
    }
  });

  return {
    gateway
  };
}

async function routeIntentNode(state: typeof AgentGraphState.State) {
  if (!state.intent) {
    throw new Error("Agent graph is missing intent.");
  }

  const route = isSalesOrderIntent(state.intent)
    ? "sales_order"
    : state.intent.intent === "analytics_query"
      ? "analytics"
      : "legacy";
  await recordAgentStep({
    name: "route_intent",
    status: "success",
    durationMs: 0,
    outputs: {
      route,
      intent: state.intent.intent
    }
  });

  return {
    route
  };
}

function pickIntentRoute(state: typeof AgentGraphState.State) {
  return state.route ?? "legacy";
}

async function resolveCustomerNode(state: typeof AgentGraphState.State) {
  if (!state.intent || !state.gateway) {
    throw new Error("Agent graph is missing intent or capability gateway.");
  }

  const startedAt = performance.now();
  const matches = state.intent.customerQuery
    ? await state.gateway.searchCustomer({ query: state.intent.customerQuery })
    : [];
  const customer = matches[0] ?? null;
  await recordAgentStep({
    name: "resolve_customer",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      customerQuery: state.intent.customerQuery,
      matchedCustomer: customer?.name ?? null,
      matches: matches.length
    }
  });

  return {
    customer
  };
}

async function resolveProductsNode(state: typeof AgentGraphState.State) {
  if (!state.intent || !state.gateway) {
    throw new Error("Agent graph is missing intent or capability gateway.");
  }

  const startedAt = performance.now();
  const requestedLines = getRequestedOrderLines(state.intent);
  const resolvedLines = await Promise.all(
    requestedLines.map(async (line) => {
      const matches = await searchProductWithFallback(state.gateway!, line.productQuery);
      return {
        requested: line,
        product: matches[0] ?? null
      };
    })
  );

  await recordAgentStep({
    name: "resolve_products",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      requestedLines,
      resolvedProducts: resolvedLines.map((line) => line.product?.name ?? null)
    }
  });

  return {
    requestedLines,
    resolvedLines
  };
}

function pickSalesOrderReadiness(state: typeof AgentGraphState.State) {
  const missingProducts = state.resolvedLines.some((line) => !line.product);
  if (!state.customer || state.requestedLines.length === 0 || missingProducts) {
    return "needs_context";
  }
  return "ready";
}

async function validateStockNode(state: typeof AgentGraphState.State) {
  if (!state.gateway) {
    throw new Error("Agent graph is missing capability gateway.");
  }

  const startedAt = performance.now();
  const stockResults = await Promise.all(
    state.resolvedLines.map((line) =>
      state.gateway!.validateStock({
        productId: line.product!.id,
        quantity: line.requested.quantity
      })
    )
  );

  await recordAgentStep({
    name: "validate_stock",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      lines: stockResults.map((stock) => ({
        productId: stock.productId,
        requested: stock.requested,
        available: stock.available,
        valid: stock.valid
      }))
    }
  });

  return {
    stockResults
  };
}

async function prepareSalesOrderNode(state: typeof AgentGraphState.State) {
  if (!state.gateway || !state.customer) {
    throw new Error("Agent graph is missing capability gateway or customer.");
  }

  const startedAt = performance.now();
  const preview = await state.gateway.prepareSalesOrder({
    customerId: state.customer.id,
    lines: state.resolvedLines.map((line) => ({
      productId: line.product!.id,
      quantity: line.requested.quantity
    }))
  });

  await recordAgentStep({
    name: "prepare_sales_order",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      customer: preview.customer.name,
      subtotal: preview.subtotal,
      lines: preview.lines.map((line) => ({
        product: line.name,
        quantity: line.quantity,
        total: line.total
      }))
    }
  });

  return {
    preview
  };
}

async function composeSalesOrderResponseNode(state: typeof AgentGraphState.State) {
  if (!state.intent) {
    throw new Error("Agent graph is missing intent.");
  }

  const startedAt = performance.now();
  const response = state.preview
    ? createPreparedOrderResponse(state)
    : createOrderClarificationResponse(state);

  await recordAgentStep({
    name: "compose_sales_order_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      hasPreview: Boolean(response.preview),
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

async function buildAnalyticsQueryNode(state: typeof AgentGraphState.State) {
  if (!state.intent) {
    throw new Error("Agent graph is missing intent.");
  }

  const startedAt = performance.now();
  const analytics = state.intent.analytics ?? {
    metric: "units_sold" as const,
    groupBy: null,
    dateRange: "today" as const
  };
  const analyticsQuery =
    analytics.metric && analytics.dateRange
      ? {
          metric: analytics.metric,
          productQuery: state.intent.productQuery,
          customerQuery: state.intent.customerQuery,
          dateRange: analytics.dateRange,
          groupBy: analytics.groupBy
        }
      : null;

  await recordAgentStep({
    name: "build_analytics_query",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      analyticsQuery
    }
  });

  return {
    analyticsQuery
  };
}

function pickAnalyticsReadiness(state: typeof AgentGraphState.State) {
  return state.analyticsQuery ? "ready" : "needs_context";
}

async function runAnalyticsQueryNode(state: typeof AgentGraphState.State) {
  if (!state.gateway || !state.analyticsQuery) {
    throw new Error("Agent graph is missing capability gateway or analytics query.");
  }

  const startedAt = performance.now();
  const analyticsResult = await state.gateway.querySalesMetrics(state.analyticsQuery);
  await recordAgentStep({
    name: "run_analytics_query",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      label: analyticsResult.label,
      metric: analyticsResult.metric,
      value: analyticsResult.value,
      rows: analyticsResult.rows.length
    }
  });

  return {
    analyticsResult
  };
}

async function composeAnalyticsResponseNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const response = state.analyticsResult && state.analyticsQuery
    ? createAnalyticsResponse(state)
    : createAnalyticsClarificationResponse(state);

  await recordAgentStep({
    name: "compose_analytics_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      hasAnalytics: Boolean(response.analyticsResult),
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

async function executeLegacyPlanNode(state: typeof AgentGraphState.State) {
  if (!state.intent || !state.gateway) {
    throw new Error("Agent graph is missing intent or capability gateway.");
  }

  const startedAt = performance.now();
  const response = await runDemoAgent({
    message: state.message,
    intent: state.intent,
    mode: state.mode,
    gateway: state.gateway,
    lastOrderId: state.lastOrderId
  });
  await recordAgentStep({
    name: "execute_legacy_plan",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      hasPreview: Boolean(response.preview),
      hasOrder: Boolean(response.order),
      hasInvoice: Boolean(response.invoice),
      hasAnalytics: Boolean(response.analyticsResult),
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

function isSalesOrderIntent(intent: AgentIntent) {
  return intent.intent === "create_order" || intent.intent === "create_order_with_invoice";
}

function getRequestedOrderLines(intent: AgentIntent): RequestedOrderLine[] {
  if (intent.orderLines && intent.orderLines.length > 0) {
    return intent.orderLines;
  }
  if (intent.productQuery && intent.quantity) {
    return [{ productQuery: intent.productQuery, quantity: intent.quantity }];
  }
  return [];
}

function createPreparedOrderResponse(state: typeof AgentGraphState.State): AgentResponse {
  const preview = state.preview!;
  const customer = state.customer!;
  const itemSummary = preview.lines
    .map((line) => `${line.quantity}x ${line.name}`)
    .join(", ");

  return {
    mode: state.mode,
    preview,
    message: {
      id: createId("msg"),
      role: "agent",
      text: state.intent?.wantsInvoice
        ? `Encontrei ${customer.name}, localizei ${itemSummary}, validei estoque e preparei uma previa de ${money(preview.subtotal)}. Depois da sua confirmacao, criarei o pedido e a nota conceitual.`
        : `Encontrei ${customer.name}, localizei ${itemSummary}, validei estoque e preparei uma previa de ${money(preview.subtotal)}. Preciso da sua confirmacao antes de criar o pedido.`
    },
    auditEvents: [
      audit("search_customer", `Matched customer ${customer.name}.`),
      audit("search_product", `Matched products: ${preview.lines.map((line) => line.name).join(", ")}.`),
      audit(
        "validate_stock",
        `Validated ${state.stockResults.length} line(s): ${state.stockResults
          .map((stock) => `${stock.requested}/${stock.available}`)
          .join(", ")}.`
      ),
      audit("prepare_sales_order", `Prepared preview for ${money(preview.subtotal)}.`)
    ],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createOrderClarificationResponse(state: typeof AgentGraphState.State): AgentResponse {
  const missingProducts = state.resolvedLines
    .filter((line) => !line.product)
    .map((line) => line.requested.productQuery);
  const missing = [
    state.customer ? null : "cliente",
    state.requestedLines.length ? null : "produto e quantidade",
    ...missingProducts.map((product) => `produto ${product}`)
  ].filter(Boolean);

  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: `Consigo preparar o pedido, mas preciso de mais contexto: informe ${missing.join(", ")}.`
    },
    auditEvents: [audit("clarification_required", `Missing fields: ${missing.join(", ")}.`, "agent")],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createAnalyticsResponse(state: typeof AgentGraphState.State): AgentResponse {
  const analyticsResult = state.analyticsResult!;
  const analyticsQuery = state.analyticsQuery!;

  return {
    mode: state.mode,
    analyticsResult,
    message: {
      id: createId("msg"),
      role: "agent",
      text: formatAnalyticsAnswer(
        analyticsResult.metric,
        analyticsResult.value,
        analyticsQuery.productQuery,
        analyticsQuery.dateRange
      )
    },
    auditEvents: [audit("query_sales_metrics", `Queried ${analyticsResult.label}.`)],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createAnalyticsClarificationResponse(state: typeof AgentGraphState.State): AgentResponse {
  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: "Consigo analisar vendas, mas preciso saber qual metrica ou periodo voce quer consultar."
    },
    auditEvents: [audit("analytics_clarification_required", "Missing analytics metric or date range.", "agent")],
    lastOrderId: state.lastOrderId ?? null
  };
}

function formatAnalyticsAnswer(
  metric: AnalyticsMetric,
  value: number,
  productQuery: string | null,
  dateRange: AnalyticsDateRange
) {
  const period =
    dateRange === "today"
      ? "hoje"
      : dateRange === "last_7_days"
        ? "nos ultimos 7 dias"
        : dateRange === "month_to_date"
          ? "neste mes"
          : "no historico";
  const subject = productQuery ? `${productQuery}` : "vendas";

  if (metric === "revenue") {
    return `O faturamento de ${subject} ${period} foi ${money(value)}.`;
  }
  if (metric === "order_count") {
    return `Foram criados ${value} pedido(s) ${period}.`;
  }
  return `Foram vendidas ${value} unidade(s) de ${subject} ${period}.`;
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
