import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type {
  AgentResponse,
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  AnalyticsResult,
  AuditEvent,
  ConceptInvoice,
  Customer,
  Product,
  SalesOrder,
  SalesOrderPreview,
  Supplier
} from "@anti-erp/shared";
import { getCapabilityGateway, type CapabilityGateway } from "../capabilities";
import { recordAgentStep } from "../observability/mcp-trace";
import { parseIntentLocally } from "./intent-parser";
import { inferIntentWithOpenRouter, type AgentIntent } from "./openrouter";

type AgentGraphInput = {
  message: string;
  lastOrderId?: string;
};

type AgentRoute =
  | "sales_order"
  | "analytics"
  | "catalog"
  | "product_update"
  | "invoice"
  | "orders_list"
  | "traditional_flow"
  | "unknown";

type CatalogKind = "customer" | "product" | "supplier";

type CatalogCommand = {
  kind: CatalogKind;
  name: string;
};

type CatalogRecord = Customer | Product | Supplier;

type ProductUpdateCommand = {
  productQuery: string;
  unitPrice: number | null;
  availableStock: number | null;
};

type AnalyticsQuery = {
  metric: AnalyticsMetric;
  productQuery: string | null;
  productQueries: string[] | null;
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
  message: Annotation<string | undefined>,
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
  catalogCommand: Annotation<CatalogCommand | null>,
  catalogRecord: Annotation<CatalogRecord | null>,
  catalogError: Annotation<string | null>,
  productUpdateCommand: Annotation<ProductUpdateCommand | null>,
  productToUpdate: Annotation<Product | null>,
  updatedProduct: Annotation<Product | null>,
  existingOrder: Annotation<SalesOrder | null>,
  invoice: Annotation<ConceptInvoice | null>,
  recentOrders: Annotation<SalesOrder[]>,
  traditionalFlow: Annotation<{ traditional: string[]; antiErp: string[] } | null>,
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
  .addNode("validate_catalog_command", validateCatalogCommandNode)
  .addNode("create_catalog_record", createCatalogRecordNode)
  .addNode("compose_catalog_response", composeCatalogResponseNode)
  .addNode("validate_product_update_command", validateProductUpdateCommandNode)
  .addNode("resolve_product_to_update", resolveProductToUpdateNode)
  .addNode("apply_product_update", applyProductUpdateNode)
  .addNode("compose_product_update_response", composeProductUpdateResponseNode)
  .addNode("load_order_for_invoice", loadOrderForInvoiceNode)
  .addNode("create_concept_invoice", createConceptInvoiceNode)
  .addNode("compose_invoice_response", composeInvoiceResponseNode)
  .addNode("list_recent_orders", listRecentOrdersNode)
  .addNode("compose_orders_list_response", composeOrdersListResponseNode)
  .addNode("load_traditional_flow", loadTraditionalFlowNode)
  .addNode("compose_traditional_flow_response", composeTraditionalFlowResponseNode)
  .addNode("compose_unknown_response", composeUnknownResponseNode)
  .addEdge(START, "parse_local_intent")
  .addEdge("parse_local_intent", "infer_openrouter_intent")
  .addEdge("infer_openrouter_intent", "load_capability_gateway")
  .addEdge("load_capability_gateway", "route_intent")
  .addConditionalEdges("route_intent", pickIntentRoute, {
    sales_order: "resolve_customer",
    analytics: "build_analytics_query",
    catalog: "validate_catalog_command",
    product_update: "validate_product_update_command",
    invoice: "load_order_for_invoice",
    orders_list: "list_recent_orders",
    traditional_flow: "load_traditional_flow",
    unknown: "compose_unknown_response"
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
  .addConditionalEdges("validate_catalog_command", pickCatalogReadiness, {
    ready: "create_catalog_record",
    needs_context: "compose_catalog_response"
  })
  .addEdge("create_catalog_record", "compose_catalog_response")
  .addEdge("compose_catalog_response", END)
  .addConditionalEdges("validate_product_update_command", pickProductUpdateCommandReadiness, {
    ready: "resolve_product_to_update",
    needs_context: "compose_product_update_response"
  })
  .addConditionalEdges("resolve_product_to_update", pickProductUpdateProductReadiness, {
    ready: "apply_product_update",
    not_found: "compose_product_update_response"
  })
  .addEdge("apply_product_update", "compose_product_update_response")
  .addEdge("compose_product_update_response", END)
  .addConditionalEdges("load_order_for_invoice", pickInvoiceOrderReadiness, {
    ready: "create_concept_invoice",
    needs_context: "compose_invoice_response"
  })
  .addEdge("create_concept_invoice", "compose_invoice_response")
  .addEdge("compose_invoice_response", END)
  .addEdge("list_recent_orders", "compose_orders_list_response")
  .addEdge("compose_orders_list_response", END)
  .addEdge("load_traditional_flow", "compose_traditional_flow_response")
  .addEdge("compose_traditional_flow_response", END)
  .addEdge("compose_unknown_response", END)
  .compile();

export async function runAgentGraph(input: AgentGraphInput) {
  const result = await antiErpAgentGraph.invoke({
    message: normalizeInputMessage(input.message),
    lastOrderId: input.lastOrderId,
    mode: process.env.OPENROUTER_API_KEY ? "openrouter" : "langgraph",
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
    catalogCommand: null,
    catalogRecord: null,
    catalogError: null,
    productUpdateCommand: null,
    productToUpdate: null,
    updatedProduct: null,
    existingOrder: null,
    invoice: null,
    recentOrders: [],
    traditionalFlow: null,
    response: null
  });

  if (!result.response) {
    throw new Error("Agent graph completed without a response.");
  }
  return result.response;
}

function normalizeInputMessage(message: unknown) {
  return typeof message === "string" ? message : "";
}

async function parseLocalIntentNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const message = normalizeInputMessage(state.message);
  const intent = parseIntentLocally(message);
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
    message,
    intent
  };
}

async function inferOpenRouterIntentNode(state: typeof AgentGraphState.State) {
  const message = normalizeInputMessage(state.message);
  if (!message || !process.env.OPENROUTER_API_KEY) {
    return {
      mode: "langgraph" satisfies AgentResponse["mode"]
    };
  }

  const startedAt = performance.now();
  try {
    const remoteIntent = await inferIntentWithOpenRouter(message);
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
      mode: "langgraph" satisfies AgentResponse["mode"]
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
      : isCatalogIntent(state.intent)
        ? "catalog"
        : state.intent.intent === "update_product"
          ? "product_update"
          : state.intent.intent === "create_invoice"
            ? "invoice"
            : state.intent.intent === "list_orders"
              ? "orders_list"
              : state.intent.intent === "traditional_flow"
                ? "traditional_flow"
                : "unknown";
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
  return state.route ?? "unknown";
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
          productQueries: analytics.productQueries ?? null,
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

async function validateCatalogCommandNode(state: typeof AgentGraphState.State) {
  if (!state.intent) {
    throw new Error("Agent graph is missing intent.");
  }

  const startedAt = performance.now();
  const kind = getCatalogKind(state.intent);
  const catalogCommand = kind && state.intent.catalogName
    ? {
        kind,
        name: state.intent.catalogName
      }
    : null;

  await recordAgentStep({
    name: "validate_catalog_command",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      catalogCommand,
      intent: state.intent.intent
    }
  });

  return {
    catalogCommand
  };
}

function pickCatalogReadiness(state: typeof AgentGraphState.State) {
  return state.catalogCommand ? "ready" : "needs_context";
}

async function createCatalogRecordNode(state: typeof AgentGraphState.State) {
  if (!state.gateway || !state.catalogCommand) {
    throw new Error("Agent graph is missing capability gateway or catalog command.");
  }

  const startedAt = performance.now();
  try {
    const catalogRecord = await createCatalogRecord(state.gateway, state.catalogCommand);
    await recordAgentStep({
      name: "create_catalog_record",
      status: "success",
      durationMs: performance.now() - startedAt,
      outputs: {
        kind: state.catalogCommand.kind,
        id: catalogRecord.id,
        name: catalogRecord.name
      }
    });

    return {
      catalogRecord,
      catalogError: null
    };
  } catch (error) {
    const catalogError = error instanceof Error ? error.message : "Unknown catalog creation error.";
    await recordAgentStep({
      name: "create_catalog_record",
      status: "error",
      durationMs: performance.now() - startedAt,
      error,
      outputs: {
        kind: state.catalogCommand.kind,
        name: state.catalogCommand.name
      }
    });

    return {
      catalogRecord: null,
      catalogError
    };
  }
}

async function composeCatalogResponseNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const response = createCatalogResponse(state);

  await recordAgentStep({
    name: "compose_catalog_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      created: Boolean(state.catalogRecord),
      error: state.catalogError
    }
  });

  return {
    response
  };
}

async function validateProductUpdateCommandNode(state: typeof AgentGraphState.State) {
  if (!state.intent) {
    throw new Error("Agent graph is missing intent.");
  }

  const startedAt = performance.now();
  const update = state.intent.productUpdate;
  const productUpdateCommand =
    update?.productQuery && (update.unitPrice !== null || update.availableStock !== null)
      ? {
          productQuery: update.productQuery,
          unitPrice: update.unitPrice,
          availableStock: update.availableStock
        }
      : null;

  await recordAgentStep({
    name: "validate_product_update_command",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      productUpdateCommand
    }
  });

  return {
    productUpdateCommand
  };
}

function pickProductUpdateCommandReadiness(state: typeof AgentGraphState.State) {
  return state.productUpdateCommand ? "ready" : "needs_context";
}

async function resolveProductToUpdateNode(state: typeof AgentGraphState.State) {
  if (!state.gateway || !state.productUpdateCommand) {
    throw new Error("Agent graph is missing capability gateway or product update command.");
  }

  const startedAt = performance.now();
  const matches = await searchProductWithFallback(state.gateway, state.productUpdateCommand.productQuery);
  const productToUpdate = matches[0] ?? null;

  await recordAgentStep({
    name: "resolve_product_to_update",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      productQuery: state.productUpdateCommand.productQuery,
      matchedProduct: productToUpdate?.name ?? null,
      matches: matches.length
    }
  });

  return {
    productToUpdate
  };
}

function pickProductUpdateProductReadiness(state: typeof AgentGraphState.State) {
  return state.productToUpdate ? "ready" : "not_found";
}

async function applyProductUpdateNode(state: typeof AgentGraphState.State) {
  if (!state.gateway || !state.productToUpdate || !state.productUpdateCommand) {
    throw new Error("Agent graph is missing capability gateway, product, or update command.");
  }

  const startedAt = performance.now();
  const updatedProduct = await state.gateway.updateProduct({
    productId: state.productToUpdate.id,
    unitPrice: state.productUpdateCommand.unitPrice,
    availableStock: state.productUpdateCommand.availableStock
  });

  await recordAgentStep({
    name: "apply_product_update",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      productId: updatedProduct.id,
      name: updatedProduct.name,
      unitPrice: updatedProduct.unitPrice,
      availableStock: updatedProduct.availableStock
    }
  });

  return {
    updatedProduct
  };
}

async function composeProductUpdateResponseNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const response = createProductUpdateResponse(state);

  await recordAgentStep({
    name: "compose_product_update_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      updated: Boolean(state.updatedProduct),
      productFound: Boolean(state.productToUpdate)
    }
  });

  return {
    response
  };
}

async function loadOrderForInvoiceNode(state: typeof AgentGraphState.State) {
  if (!state.gateway) {
    throw new Error("Agent graph is missing capability gateway.");
  }

  const startedAt = performance.now();
  const existingOrder = state.lastOrderId
    ? await state.gateway.getSalesOrder({ salesOrderId: state.lastOrderId })
    : null;

  await recordAgentStep({
    name: "load_order_for_invoice",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      lastOrderId: state.lastOrderId ?? null,
      found: Boolean(existingOrder)
    }
  });

  return {
    existingOrder
  };
}

function pickInvoiceOrderReadiness(state: typeof AgentGraphState.State) {
  return state.existingOrder ? "ready" : "needs_context";
}

async function createConceptInvoiceNode(state: typeof AgentGraphState.State) {
  if (!state.gateway || !state.existingOrder) {
    throw new Error("Agent graph is missing capability gateway or existing order.");
  }

  const startedAt = performance.now();
  const invoice = await state.gateway.createConceptInvoice({
    salesOrderId: state.existingOrder.id
  });

  await recordAgentStep({
    name: "create_concept_invoice",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      invoiceId: invoice.id,
      salesOrderId: invoice.salesOrderId,
      amount: invoice.amount
    }
  });

  return {
    invoice
  };
}

async function composeInvoiceResponseNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const response = createInvoiceResponse(state);

  await recordAgentStep({
    name: "compose_invoice_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      hasInvoice: Boolean(response.invoice),
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

async function listRecentOrdersNode(state: typeof AgentGraphState.State) {
  if (!state.gateway) {
    throw new Error("Agent graph is missing capability gateway.");
  }

  const startedAt = performance.now();
  const recentOrders = await state.gateway.listRecentOrders();

  await recordAgentStep({
    name: "list_recent_orders",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      orders: recentOrders.length
    }
  });

  return {
    recentOrders
  };
}

async function composeOrdersListResponseNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const response = createOrdersListResponse(state);

  await recordAgentStep({
    name: "compose_orders_list_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      orders: state.recentOrders.length,
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

async function loadTraditionalFlowNode(state: typeof AgentGraphState.State) {
  if (!state.gateway) {
    throw new Error("Agent graph is missing capability gateway.");
  }

  const startedAt = performance.now();
  const traditionalFlow = await state.gateway.getTraditionalErpFlow();

  await recordAgentStep({
    name: "load_traditional_flow",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      traditionalSteps: traditionalFlow.traditional.length,
      antiErpSteps: traditionalFlow.antiErp.length
    }
  });

  return {
    traditionalFlow
  };
}

async function composeTraditionalFlowResponseNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const response = createTraditionalFlowResponse(state);

  await recordAgentStep({
    name: "compose_traditional_flow_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      loaded: Boolean(state.traditionalFlow),
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

async function composeUnknownResponseNode(state: typeof AgentGraphState.State) {
  const startedAt = performance.now();
  const response = createUnknownResponse(state);

  await recordAgentStep({
    name: "compose_unknown_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
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

function isCatalogIntent(intent: AgentIntent) {
  return intent.intent === "create_customer"
    || intent.intent === "create_product"
    || intent.intent === "create_supplier";
}

function getCatalogKind(intent: AgentIntent): CatalogKind | null {
  if (intent.intent === "create_customer") {
    return "customer";
  }
  if (intent.intent === "create_product") {
    return "product";
  }
  if (intent.intent === "create_supplier") {
    return "supplier";
  }
  return null;
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

async function createCatalogRecord(gateway: CapabilityGateway, command: CatalogCommand): Promise<CatalogRecord> {
  if (command.kind === "customer") {
    return gateway.createCustomer({ name: command.name });
  }
  if (command.kind === "product") {
    return gateway.createProduct({ name: command.name });
  }
  return gateway.createSupplier({ name: command.name });
}

function createCatalogResponse(state: typeof AgentGraphState.State): AgentResponse {
  const command = state.catalogCommand;
  if (!command) {
    const label = getCatalogLabelFromIntent(state.intent);
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Consigo cadastrar o ${label}, mas preciso do nome.`
      },
      auditEvents: [audit("catalog_name_required", `${capitalize(label)} creation blocked without a name.`, "agent")],
      lastOrderId: state.lastOrderId ?? null
    };
  }

  if (state.catalogError) {
    return createCatalogErrorResponse(state.mode, state.lastOrderId, state.catalogError, command.kind);
  }

  const record = state.catalogRecord;
  if (!record) {
    return createCatalogErrorResponse(state.mode, state.lastOrderId, "Catalog record was not created.", command.kind);
  }

  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: formatCatalogSuccessMessage(command.kind, record)
    },
    auditEvents: [audit(`create_${command.kind}`, `Created ${command.kind} ${record.name}.`)],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createProductUpdateResponse(state: typeof AgentGraphState.State): AgentResponse {
  const command = state.productUpdateCommand;
  if (!command) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: "Consigo atualizar o produto, mas preciso saber o produto e o novo preco ou estoque."
      },
      auditEvents: [audit("product_update_context_required", "Product update blocked without product or field value.", "agent")],
      lastOrderId: state.lastOrderId ?? null
    };
  }

  if (!state.productToUpdate) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Nao encontrei um produto chamado ${command.productQuery}.`
      },
      auditEvents: [audit("update_product_not_found", `Product ${command.productQuery} was not found.`, "agent")],
      lastOrderId: state.lastOrderId ?? null
    };
  }

  const updatedProduct = state.updatedProduct;
  if (!updatedProduct) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: "Nao consegui atualizar o produto agora. Nenhuma alteracao foi aplicada."
      },
      auditEvents: [audit("update_product_failed", `Failed to update product ${state.productToUpdate.name}.`, "agent")],
      lastOrderId: state.lastOrderId ?? null
    };
  }

  const changedFields = [
    command.unitPrice !== null ? `preco ${money(updatedProduct.unitPrice)}` : null,
    command.availableStock !== null ? `estoque ${updatedProduct.availableStock}` : null
  ].filter(Boolean);

  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: `Produto ${updatedProduct.name} atualizado: ${changedFields.join(", ")}.`
    },
    auditEvents: [
      audit("search_product", `Matched product ${updatedProduct.name}.`),
      audit("update_product", `Updated product ${updatedProduct.name}.`)
    ],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createInvoiceResponse(state: typeof AgentGraphState.State): AgentResponse {
  if (!state.lastOrderId || !state.existingOrder) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: "Ainda nao tenho um pedido confirmado nesta sessao. Crie e confirme um pedido primeiro; depois eu gero a nota conceitual."
      },
      auditEvents: [audit("create_concept_invoice_blocked", "Invoice creation blocked without an existing order.", "agent")],
      lastOrderId: state.lastOrderId ?? null
    };
  }

  if (!state.invoice) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: "Nao consegui gerar a nota conceitual agora. Nenhuma nota foi criada."
      },
      auditEvents: [audit("create_concept_invoice_failed", `Failed to generate concept invoice for ${state.lastOrderId}.`, "agent")],
      lastOrderId: state.lastOrderId
    };
  }

  return {
    mode: state.mode,
    invoice: state.invoice,
    message: {
      id: createId("msg"),
      role: "agent",
      text: `Nota conceitual ${state.invoice.id} gerada para o pedido ${state.lastOrderId}.`
    },
    auditEvents: [audit("create_concept_invoice", `Generated concept invoice ${state.invoice.id}.`)],
    lastOrderId: state.lastOrderId
  };
}

function createOrdersListResponse(state: typeof AgentGraphState.State): AgentResponse {
  const orders = state.recentOrders;
  return {
    mode: state.mode,
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
    lastOrderId: state.lastOrderId ?? null
  };
}

function createTraditionalFlowResponse(state: typeof AgentGraphState.State): AgentResponse {
  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text:
        "Em um ERP tradicional voce abriria cadastro, pedido, estoque e faturamento em telas separadas. No anti-ERP, a intencao vira uma sequencia auditavel de capacidades MCP."
    },
    auditEvents: [
      audit("get_traditional_erp_flow", "Compared traditional ERP flow with anti-ERP flow.")
    ],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createUnknownResponse(state: typeof AgentGraphState.State): AgentResponse {
  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text:
        "Posso cadastrar clientes, produtos e fornecedores, criar pedidos, gerar nota conceitual para um pedido confirmado, listar pedidos recentes ou comparar com um ERP tradicional."
    },
    auditEvents: [audit("unknown_intent", "Agent could not map the message to a supported MCP capability.", "agent")],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createCatalogErrorResponse(
  mode: AgentResponse["mode"],
  lastOrderId: string | undefined,
  error: string,
  kind: CatalogKind
): AgentResponse {
  const label = getCatalogLabel(kind);
  const duplicate = /already exists/i.test(error);
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

function formatCatalogSuccessMessage(kind: CatalogKind, record: CatalogRecord) {
  if (kind === "customer") {
    const customer = record as Customer;
    return `Cliente ${customer.name} cadastrado com status ${customer.status}. Cidade: ${customer.city}.`;
  }
  if (kind === "product") {
    const product = record as Product;
    return `Produto ${product.name} cadastrado. Ele ficou com SKU ${product.sku}, preço ${money(product.unitPrice)} e estoque ${product.availableStock}.`;
  }
  const supplier = record as Supplier;
  return `Fornecedor ${supplier.name} cadastrado com status ${supplier.status}.`;
}

function getCatalogLabelFromIntent(intent: AgentIntent | null) {
  return getCatalogLabel(intent ? getCatalogKind(intent) : null);
}

function getCatalogLabel(kind: CatalogKind | null) {
  if (kind === "customer") {
    return "cliente";
  }
  if (kind === "supplier") {
    return "fornecedor";
  }
  return "produto";
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
        analyticsQuery.productQueries,
        analyticsQuery.dateRange,
        analyticsQuery.groupBy,
        analyticsResult.rows
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
  productQueries: string[] | null,
  dateRange: AnalyticsDateRange,
  groupBy: AnalyticsGroupBy | null,
  rows: Array<{ label: string; value: number }>
) {
  const period =
    dateRange === "today"
      ? "hoje"
      : dateRange === "last_7_days"
        ? "nos ultimos 7 dias"
        : dateRange === "month_to_date"
          ? "neste mes"
          : "no historico";
  const subject = productQueries?.length
    ? productQueries.join(" e ")
    : productQuery ? `${productQuery}` : metric === "units_sold" ? "produtos" : "vendas";

  if (metric === "revenue") {
    return appendAnalyticsRows(`O faturamento de ${subject} ${period} foi ${money(value)}.`, metric, groupBy, rows);
  }
  if (metric === "order_count") {
    return appendAnalyticsRows(`Foram criados ${value} pedido(s) ${period}.`, metric, groupBy, rows);
  }
  return appendAnalyticsRows(`Foram vendidas ${value} unidade(s) de ${subject} ${period}.`, metric, groupBy, rows);
}

function appendAnalyticsRows(
  base: string,
  metric: AnalyticsMetric,
  groupBy: AnalyticsGroupBy | null,
  rows: Array<{ label: string; value: number }>
) {
  if (!groupBy || rows.length === 0) {
    return base;
  }

  const groupLabel =
    groupBy === "customer"
      ? "Por cliente"
      : groupBy === "product"
        ? "Por produto"
        : "Por dia";
  const rowSummary = rows
    .slice(0, 5)
    .map((row) => `${row.label}: ${formatAnalyticsRowMetric(metric, row.value)}`)
    .join("; ");
  return `${base} ${groupLabel}: ${rowSummary}.`;
}

function formatAnalyticsRowMetric(metric: AnalyticsMetric, value: number) {
  if (metric === "revenue") {
    return money(value);
  }
  if (metric === "order_count") {
    return `${value} pedido(s)`;
  }
  return `${value} unidade(s)`;
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
