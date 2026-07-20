import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type {
  AgentResponse,
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  AnalyticsResult,
  AuditEvent,
  ClarificationRequest,
  ConceptInvoice,
  ConversationContext,
  Customer,
  ExecutionPlan,
  Product,
  SalesOrder,
  SalesOrderPreview,
  Supplier
} from "@anti-erp/shared";
import { getCapabilityGateway, type CapabilityGateway } from "../capabilities";
import { recordAgentStep } from "../observability/mcp-trace";
import { buildClarifyingFallbackQuestion } from "./clarifying-fallback";
import { createCustomerDisambiguation, createProductDisambiguation } from "./disambiguation";
import { parseIntentLocally } from "./intent-parser";
import { inferIntentWithOpenRouter, type AgentIntent } from "./openrouter";
import { buildLocalExecutionPlan, toExecutionPlan, type PlannedAction, type PlannedWorkflow } from "./planner";

type AgentGraphInput = {
  message: string;
  lastOrderId?: string;
  conversationContext?: ConversationContext | null;
};

type AgentRoute =
  | "sales_order"
  | "analytics"
  | "catalog"
  | "product_update"
  | "order_update"
  | "planned_workflow"
  | "invoice"
  | "orders_list"
  | "traditional_flow"
  | "inventory_diagnostic"
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

type OrderUpdateOperation = "add" | "set_quantity" | "remove";

type ResolvedOrderLine = {
  requested: RequestedOrderLine;
  product: Product | null;
  matches?: Product[];
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
  conversationContext: Annotation<ConversationContext | null>,
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
  orderUpdateOperation: Annotation<OrderUpdateOperation | null>,
  orderUpdateError: Annotation<string | null>,
  clarification: Annotation<ClarificationRequest | null>,
  productToUpdate: Annotation<Product | null>,
  updatedProduct: Annotation<Product | null>,
  existingOrder: Annotation<SalesOrder | null>,
  invoice: Annotation<ConceptInvoice | null>,
  recentOrders: Annotation<SalesOrder[]>,
  lowStockProducts: Annotation<Product[]>,
  plannedWorkflow: Annotation<PlannedWorkflow | null>,
  executionPlan: Annotation<ExecutionPlan | null>,
  traditionalFlow: Annotation<{ traditional: string[]; antiErp: string[] } | null>,
  response: Annotation<AgentResponse | null>
});

type AgentGraphStateValue = Record<string, any>;

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
  .addNode("validate_order_update_command", validateOrderUpdateCommandNode)
  .addNode("resolve_order_update_product", resolveOrderUpdateProductNode)
  .addNode("apply_order_line_update", applyOrderLineUpdateNode)
  .addNode("compose_order_update_response", composeOrderUpdateResponseNode)
  .addNode("build_execution_plan", buildExecutionPlanNode)
  .addNode("execute_execution_plan", executeExecutionPlanNode)
  .addNode("compose_execution_plan_response", composeExecutionPlanResponseNode)
  .addNode("load_order_for_invoice", loadOrderForInvoiceNode)
  .addNode("create_concept_invoice", createConceptInvoiceNode)
  .addNode("compose_invoice_response", composeInvoiceResponseNode)
  .addNode("list_recent_orders", listRecentOrdersNode)
  .addNode("compose_orders_list_response", composeOrdersListResponseNode)
  .addNode("list_low_stock_products", listLowStockProductsNode)
  .addNode("compose_inventory_diagnostic_response", composeInventoryDiagnosticResponseNode)
  .addNode("load_traditional_flow", loadTraditionalFlowNode)
  .addNode("compose_traditional_flow_response", composeTraditionalFlowResponseNode)
  .addNode("compose_unknown_response", composeUnknownResponseNode)
  .addEdge(START, "parse_local_intent")
  .addEdge("parse_local_intent", "infer_openrouter_intent")
  .addEdge("infer_openrouter_intent", "route_intent")
  .addConditionalEdges("route_intent", pickIntentRoute, {
    sales_order: "load_capability_gateway",
    analytics: "load_capability_gateway",
    catalog: "load_capability_gateway",
    product_update: "load_capability_gateway",
    order_update: "load_capability_gateway",
    planned_workflow: "load_capability_gateway",
    invoice: "load_capability_gateway",
    orders_list: "load_capability_gateway",
    traditional_flow: "load_capability_gateway",
    inventory_diagnostic: "load_capability_gateway",
    unknown: "compose_unknown_response"
  })
  .addConditionalEdges("load_capability_gateway", pickIntentRoute, {
    sales_order: "resolve_customer",
    analytics: "build_analytics_query",
    catalog: "validate_catalog_command",
    product_update: "validate_product_update_command",
    order_update: "validate_order_update_command",
    planned_workflow: "build_execution_plan",
    invoice: "load_order_for_invoice",
    orders_list: "list_recent_orders",
    traditional_flow: "load_traditional_flow",
    inventory_diagnostic: "list_low_stock_products",
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
  .addConditionalEdges("validate_order_update_command", pickOrderUpdateCommandReadiness, {
    ready: "resolve_order_update_product",
    needs_context: "compose_order_update_response"
  })
  .addConditionalEdges("resolve_order_update_product", pickOrderUpdateProductReadiness, {
    ready: "apply_order_line_update",
    not_found: "compose_order_update_response"
  })
  .addEdge("apply_order_line_update", "compose_order_update_response")
  .addEdge("compose_order_update_response", END)
  .addEdge("build_execution_plan", "execute_execution_plan")
  .addEdge("execute_execution_plan", "compose_execution_plan_response")
  .addEdge("compose_execution_plan_response", END)
  .addConditionalEdges("load_order_for_invoice", pickInvoiceOrderReadiness, {
    ready: "create_concept_invoice",
    needs_context: "compose_invoice_response"
  })
  .addEdge("create_concept_invoice", "compose_invoice_response")
  .addEdge("compose_invoice_response", END)
  .addEdge("list_recent_orders", "compose_orders_list_response")
  .addEdge("compose_orders_list_response", END)
  .addEdge("list_low_stock_products", "compose_inventory_diagnostic_response")
  .addEdge("compose_inventory_diagnostic_response", END)
  .addEdge("load_traditional_flow", "compose_traditional_flow_response")
  .addEdge("compose_traditional_flow_response", END)
  .addEdge("compose_unknown_response", END)
  .compile();

export async function runAgentGraph(input: AgentGraphInput) {
  const result = await antiErpAgentGraph.invoke({
    message: normalizeInputMessage(input.message),
    lastOrderId: input.lastOrderId,
    conversationContext: input.conversationContext ?? null,
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
    orderUpdateOperation: null,
    orderUpdateError: null,
    clarification: null,
    productToUpdate: null,
    updatedProduct: null,
    existingOrder: null,
    invoice: null,
    recentOrders: [],
    lowStockProducts: [],
    plannedWorkflow: null,
    executionPlan: null,
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

async function parseLocalIntentNode(state: AgentGraphStateValue) {
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

async function inferOpenRouterIntentNode(state: AgentGraphStateValue) {
  const message = normalizeInputMessage(state.message);
  if (!message || !process.env.OPENROUTER_API_KEY) {
    return {
      mode: "langgraph" satisfies AgentResponse["mode"]
    };
  }
  if (state.intent && state.intent.intent !== "unknown" && state.intent.confidence >= 0.8) {
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

async function routeIntentNode(state: AgentGraphStateValue) {
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
          : isOrderUpdateIntent(state.intent)
            ? "order_update"
            : state.intent.intent === "planned_workflow"
              ? "planned_workflow"
              : state.intent.intent === "create_invoice"
                ? "invoice"
                : state.intent.intent === "list_orders"
                  ? "orders_list"
                  : state.intent.intent === "traditional_flow"
                    ? "traditional_flow"
                    : state.intent.intent === "inventory_diagnostic"
                      ? "inventory_diagnostic"
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

function pickIntentRoute(state: AgentGraphStateValue) {
  return state.route ?? "unknown";
}

async function resolveCustomerNode(state: AgentGraphStateValue) {
  if (!state.intent || !state.gateway) {
    throw new Error("Agent graph is missing intent or capability gateway.");
  }

  const startedAt = performance.now();
  const matches = state.intent.customerQuery
    ? await state.gateway.searchCustomer({ query: state.intent.customerQuery })
    : [];
  const clarification = matches.length > 1
    ? createCustomerDisambiguation(state.intent.customerQuery ?? "", matches)
    : null;
  const customer = clarification ? null : matches[0] ?? null;
  await recordAgentStep({
    name: "resolve_customer",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      customerQuery: state.intent.customerQuery,
      matchedCustomer: customer?.name ?? null,
      matches: matches.length,
      ambiguous: Boolean(clarification)
    }
  });

  return {
    customer,
    clarification
  };
}

async function resolveProductsNode(state: AgentGraphStateValue) {
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
        product: matches.length === 1 ? matches[0] ?? null : null,
        matches
      };
    })
  );
  const ambiguousLine = resolvedLines.find((line) => line.matches && line.matches.length > 1);
  const clarification = state.clarification ?? (ambiguousLine
    ? createProductDisambiguation(ambiguousLine.requested.productQuery, ambiguousLine.matches ?? [])
    : null);

  await recordAgentStep({
    name: "resolve_products",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      requestedLines,
      resolvedProducts: resolvedLines.map((line) => line.product?.name ?? null),
      ambiguousProduct: ambiguousLine?.requested.productQuery ?? null
    }
  });

  return {
    requestedLines,
    resolvedLines,
    clarification
  };
}

function pickSalesOrderReadiness(state: AgentGraphStateValue) {
  if (state.clarification) {
    return "needs_context";
  }
  const missingProducts = state.resolvedLines.some((line: ResolvedOrderLine) => !line.product);
  if (!state.customer || state.requestedLines.length === 0 || missingProducts) {
    return "needs_context";
  }
  return "ready";
}

async function validateStockNode(state: AgentGraphStateValue) {
  if (!state.gateway) {
    throw new Error("Agent graph is missing capability gateway.");
  }

  const startedAt = performance.now();
  const stockResults = await Promise.all(
    state.resolvedLines.map((line: ResolvedOrderLine) =>
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
      lines: stockResults.map((stock: StockResult) => ({
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

async function prepareSalesOrderNode(state: AgentGraphStateValue) {
  if (!state.gateway || !state.customer) {
    throw new Error("Agent graph is missing capability gateway or customer.");
  }

  const startedAt = performance.now();
  const preview = await state.gateway.prepareSalesOrder({
    customerId: state.customer.id,
    lines: state.resolvedLines.map((line: ResolvedOrderLine) => ({
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
      lines: preview.lines.map((line: SalesOrderPreview["lines"][number]) => ({
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

async function composeSalesOrderResponseNode(state: AgentGraphStateValue) {
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

async function buildAnalyticsQueryNode(state: AgentGraphStateValue) {
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

function pickAnalyticsReadiness(state: AgentGraphStateValue) {
  return state.analyticsQuery ? "ready" : "needs_context";
}

async function runAnalyticsQueryNode(state: AgentGraphStateValue) {
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

async function composeAnalyticsResponseNode(state: AgentGraphStateValue) {
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

async function validateCatalogCommandNode(state: AgentGraphStateValue) {
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

function pickCatalogReadiness(state: AgentGraphStateValue) {
  return state.catalogCommand ? "ready" : "needs_context";
}

async function createCatalogRecordNode(state: AgentGraphStateValue) {
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

async function composeCatalogResponseNode(state: AgentGraphStateValue) {
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

async function validateProductUpdateCommandNode(state: AgentGraphStateValue) {
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

function pickProductUpdateCommandReadiness(state: AgentGraphStateValue) {
  return state.productUpdateCommand ? "ready" : "needs_context";
}

async function resolveProductToUpdateNode(state: AgentGraphStateValue) {
  if (!state.gateway || !state.productUpdateCommand) {
    throw new Error("Agent graph is missing capability gateway or product update command.");
  }

  const startedAt = performance.now();
  const matches = await searchProductWithFallback(state.gateway, state.productUpdateCommand.productQuery);
  const clarification = matches.length > 1
    ? createProductDisambiguation(state.productUpdateCommand.productQuery, matches)
    : null;
  const productToUpdate = clarification ? null : matches[0] ?? null;

  await recordAgentStep({
    name: "resolve_product_to_update",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      productQuery: state.productUpdateCommand.productQuery,
      matchedProduct: productToUpdate?.name ?? null,
      matches: matches.length,
      ambiguous: Boolean(clarification)
    }
  });

  return {
    productToUpdate,
    clarification
  };
}

function pickProductUpdateProductReadiness(state: AgentGraphStateValue) {
  return state.productToUpdate ? "ready" : "not_found";
}

async function applyProductUpdateNode(state: AgentGraphStateValue) {
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

async function composeProductUpdateResponseNode(state: AgentGraphStateValue) {
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

async function validateOrderUpdateCommandNode(state: AgentGraphStateValue) {
  if (!state.intent) {
    throw new Error("Agent graph is missing intent.");
  }

  const startedAt = performance.now();
  const requestedLines = getRequestedOrderLines(state.intent).slice(0, 1);
  const orderUpdateOperation = getOrderUpdateOperation(state.intent);
  const hasContext = Boolean(state.lastOrderId && requestedLines.length > 0);
  await recordAgentStep({
    name: "validate_order_update_command",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      lastOrderId: state.lastOrderId ?? null,
      requestedLines,
      orderUpdateOperation,
      hasContext
    }
  });

  return {
    requestedLines,
    orderUpdateOperation
  };
}

function pickOrderUpdateCommandReadiness(state: AgentGraphStateValue) {
  return state.lastOrderId && state.requestedLines.length > 0 && state.orderUpdateOperation ? "ready" : "needs_context";
}

async function resolveOrderUpdateProductNode(state: AgentGraphStateValue) {
  if (!state.gateway || state.requestedLines.length === 0) {
    throw new Error("Agent graph is missing capability gateway or order update command.");
  }

  const startedAt = performance.now();
  const requested = state.requestedLines[0] as RequestedOrderLine;
  const matches = await searchProductWithFallback(state.gateway, requested.productQuery);
  const clarification = matches.length > 1
    ? createProductDisambiguation(requested.productQuery, matches)
    : null;
  const resolvedLines = [
    {
      requested,
      product: clarification ? null : matches[0] ?? null,
      matches
    }
  ];

  await recordAgentStep({
    name: "resolve_order_update_product",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      productQuery: requested.productQuery,
      matchedProduct: resolvedLines[0]?.product?.name ?? null,
      matches: matches.length,
      ambiguous: Boolean(clarification)
    }
  });

  return {
    resolvedLines,
    clarification
  };
}

function pickOrderUpdateProductReadiness(state: AgentGraphStateValue) {
  const line = state.resolvedLines[0] as ResolvedOrderLine | undefined;
  return line?.product ? "ready" : "not_found";
}

async function applyOrderLineUpdateNode(state: AgentGraphStateValue) {
  if (!state.gateway || !state.lastOrderId) {
    throw new Error("Agent graph is missing capability gateway or order context.");
  }
  const line = state.resolvedLines[0] as ResolvedOrderLine | undefined;
  if (!line?.product) {
    throw new Error("Agent graph is missing resolved product for order update.");
  }

  const startedAt = performance.now();
  try {
    const existingOrder =
      state.orderUpdateOperation === "remove"
        ? await state.gateway.removeSalesOrderLine({
            salesOrderId: state.lastOrderId,
            productId: line.product.id
          })
        : state.orderUpdateOperation === "set_quantity"
          ? await state.gateway.setSalesOrderLineQuantity({
              salesOrderId: state.lastOrderId,
              productId: line.product.id,
              quantity: line.requested.quantity
            })
          : await state.gateway.addSalesOrderLine({
              salesOrderId: state.lastOrderId,
              productId: line.product.id,
              quantity: line.requested.quantity
            });

    await recordAgentStep({
      name: "apply_order_line_update",
      status: "success",
      durationMs: performance.now() - startedAt,
      outputs: {
        salesOrderId: existingOrder.id,
        product: line.product.name,
        quantity: line.requested.quantity,
        orderUpdateOperation: state.orderUpdateOperation,
        subtotal: existingOrder.subtotal
      }
    });

    return {
      existingOrder,
      orderUpdateError: null
    };
  } catch (error) {
    const orderUpdateError = error instanceof Error ? error.message : "Unknown order update error.";
    await recordAgentStep({
      name: "apply_order_line_update",
      status: "error",
      durationMs: performance.now() - startedAt,
      error,
      outputs: {
        product: line.product.name,
        quantity: line.requested.quantity,
        orderUpdateOperation: state.orderUpdateOperation
      }
    });

    return {
      existingOrder: null,
      orderUpdateError
    };
  }
}

async function composeOrderUpdateResponseNode(state: AgentGraphStateValue) {
  const startedAt = performance.now();
  const response = createOrderUpdateResponse(state);

  await recordAgentStep({
    name: "compose_order_update_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      updated: Boolean(response.order),
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

async function buildExecutionPlanNode(state: AgentGraphStateValue) {
  const startedAt = performance.now();
  const plannedWorkflow = buildLocalExecutionPlan(normalizeInputMessage(state.message));
  const executionPlan = plannedWorkflow ? toExecutionPlan(plannedWorkflow) : null;

  await recordAgentStep({
    name: "build_execution_plan",
    status: executionPlan ? "success" : "error",
    durationMs: performance.now() - startedAt,
    outputs: {
      steps: executionPlan?.steps.map((step) => step.action) ?? []
    }
  });

  return {
    plannedWorkflow,
    executionPlan
  };
}

async function executeExecutionPlanNode(state: AgentGraphStateValue) {
  if (!state.gateway || !state.plannedWorkflow || !state.executionPlan) {
    return {};
  }

  const startedAt = performance.now();
  const executionPlan = cloneExecutionPlan(state.executionPlan);
  const context: {
    customers: Customer[];
    products: Product[];
    suppliers: Supplier[];
    preview: SalesOrderPreview | null;
    invoice: ConceptInvoice | null;
    analyticsResult: AnalyticsResult | null;
  } = {
    customers: [],
    products: [],
    suppliers: [],
    preview: null,
    invoice: null,
    analyticsResult: null
  };

  for (const [index, action] of state.plannedWorkflow.actions.entries()) {
    const step = executionPlan.steps[index];
    if (!step) {
      continue;
    }

    try {
      if (action.type === "create_customer") {
        const customer = await ensureCustomerForPlan(state.gateway, action.name);
        context.customers.push(customer);
        markPlanStep(step, "executed", `Cliente ativo: ${customer.name}.`);
      } else if (action.type === "create_product") {
        const product = await ensureProductForPlan(state.gateway, action.name);
        context.products.push(product);
        markPlanStep(step, "executed", `Produto ativo: ${product.name}.`);
      } else if (action.type === "create_supplier") {
        const supplier = await state.gateway.createSupplier({ name: action.name });
        context.suppliers.push(supplier);
        markPlanStep(step, "executed", `Fornecedor cadastrado: ${supplier.name}.`);
      } else if (action.type === "prepare_sales_order") {
        const preview = await prepareSalesOrderFromPlan(state.gateway, action, context, state.conversationContext);
        context.preview = preview;
        markPlanStep(
          step,
          "pending_confirmation",
          action.wantsInvoice
            ? "Pedido preparado. Nota conceitual ficara para depois da confirmacao."
            : "Pedido preparado e aguardando confirmacao."
        );
      } else if (action.type === "create_invoice") {
        const orderId = state.lastOrderId ?? state.conversationContext?.activeOrderId ?? null;
        if (!orderId) {
          markPlanStep(step, "pending_confirmation", "Crie ou confirme um pedido antes de gerar a nota.");
        } else {
          const invoice = await state.gateway.createConceptInvoice({ salesOrderId: orderId });
          context.invoice = invoice;
          markPlanStep(step, "executed", `Nota conceitual gerada: ${invoice.id}.`);
        }
      } else if (action.type === "query_report") {
        const analyticsResult = await state.gateway.querySalesMetrics({
          metric: action.metric,
          dateRange: action.dateRange,
          groupBy: action.groupBy,
          productQueries: action.productQueries,
          customerQuery: action.customerQuery
        });
        context.analyticsResult = analyticsResult;
        markPlanStep(step, "executed", `Relatorio gerado: ${analyticsResult.label}.`);
      }
    } catch (error) {
      markPlanStep(step, "blocked", formatPlanError(error));
    }
  }

  await recordAgentStep({
    name: "execute_execution_plan",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      executed: executionPlan.steps.filter((step) => step.status === "executed").length,
      pending: executionPlan.steps.filter((step) => step.status === "pending_confirmation").length,
      blocked: executionPlan.steps.filter((step) => step.status === "blocked").length
    }
  });

  return {
    executionPlan,
    preview: context.preview,
    invoice: context.invoice,
    analyticsResult: context.analyticsResult,
    customer: context.customers.at(-1) ?? null,
    catalogRecord: context.products.at(-1) ?? context.customers.at(-1) ?? context.suppliers.at(-1) ?? null
  };
}

async function composeExecutionPlanResponseNode(state: AgentGraphStateValue) {
  const startedAt = performance.now();
  const response = createExecutionPlanResponse(state);

  await recordAgentStep({
    name: "compose_execution_plan_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      steps: state.executionPlan?.steps.length ?? 0,
      hasPreview: Boolean(response.preview),
      hasReport: Boolean(response.analyticsResult)
    }
  });

  return {
    response
  };
}

async function loadOrderForInvoiceNode(state: AgentGraphStateValue) {
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

function pickInvoiceOrderReadiness(state: AgentGraphStateValue) {
  return state.existingOrder ? "ready" : "needs_context";
}

async function createConceptInvoiceNode(state: AgentGraphStateValue) {
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

async function composeInvoiceResponseNode(state: AgentGraphStateValue) {
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

async function listRecentOrdersNode(state: AgentGraphStateValue) {
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

async function composeOrdersListResponseNode(state: AgentGraphStateValue) {
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

async function listLowStockProductsNode(state: AgentGraphStateValue) {
  if (!state.gateway) {
    throw new Error("Agent graph is missing capability gateway.");
  }

  const startedAt = performance.now();
  const lowStockProducts = await state.gateway.listLowStockProducts({ threshold: 10 });

  await recordAgentStep({
    name: "list_low_stock_products",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      products: lowStockProducts.length,
      threshold: 10
    }
  });

  return {
    lowStockProducts
  };
}

async function composeInventoryDiagnosticResponseNode(state: AgentGraphStateValue) {
  const startedAt = performance.now();
  const response = createInventoryDiagnosticResponse(state);

  await recordAgentStep({
    name: "compose_inventory_diagnostic_response",
    status: "success",
    durationMs: performance.now() - startedAt,
    outputs: {
      products: state.lowStockProducts.length,
      auditEvents: response.auditEvents.length
    }
  });

  return {
    response
  };
}

async function loadTraditionalFlowNode(state: AgentGraphStateValue) {
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

async function composeTraditionalFlowResponseNode(state: AgentGraphStateValue) {
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

async function composeUnknownResponseNode(state: AgentGraphStateValue) {
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

function isOrderUpdateIntent(intent: AgentIntent) {
  return intent.intent === "add_item_to_order"
    || intent.intent === "set_order_item_quantity"
    || intent.intent === "remove_item_from_order";
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
  if (intent.productQuery && intent.quantity !== null) {
    return [{ productQuery: intent.productQuery, quantity: intent.quantity }];
  }
  return [];
}

function getOrderUpdateOperation(intent: AgentIntent): OrderUpdateOperation | null {
  if (intent.intent === "add_item_to_order") {
    return "add";
  }
  if (intent.intent === "set_order_item_quantity") {
    return "set_quantity";
  }
  if (intent.intent === "remove_item_from_order") {
    return "remove";
  }
  return null;
}

async function ensureCustomerForPlan(gateway: CapabilityGateway, name: string) {
  try {
    return await gateway.createCustomer({ name });
  } catch (error) {
    if (!isDuplicateError(error)) {
      throw error;
    }
    const matches = await gateway.searchCustomer({ query: name });
    const existing = matches[0];
    if (!existing) {
      throw error;
    }
    return existing;
  }
}

async function ensureProductForPlan(gateway: CapabilityGateway, name: string) {
  try {
    return await gateway.createProduct({ name });
  } catch (error) {
    if (!isDuplicateError(error)) {
      throw error;
    }
    const matches = await searchProductWithFallback(gateway, name);
    const existing = matches[0];
    if (!existing) {
      throw error;
    }
    return existing;
  }
}

async function prepareSalesOrderFromPlan(
  gateway: CapabilityGateway,
  action: Extract<PlannedAction, { type: "prepare_sales_order" }>,
  context: { customers: Customer[]; products: Product[] },
  conversationContext: ConversationContext | null | undefined
) {
  const customerQuery = action.customerQuery
    ?? context.customers.at(-1)?.name
    ?? conversationContext?.activeCustomer?.name
    ?? null;
  if (!customerQuery) {
    throw new Error("Missing customer for planned sales order.");
  }
  if (action.lines.length === 0) {
    throw new Error("Missing products for planned sales order.");
  }

  const customer = context.customers.find((candidate) => normalize(candidate.name).includes(normalize(customerQuery)))
    ?? (await gateway.searchCustomer({ query: customerQuery }))[0]
    ?? null;
  if (!customer) {
    throw new Error(`Customer ${customerQuery} not found.`);
  }

  const resolvedLines = await Promise.all(
    action.lines.map(async (line) => {
      const product = context.products.find((candidate) => normalize(candidate.name).includes(normalize(line.productQuery)))
        ?? (await searchProductWithFallback(gateway, line.productQuery))[0]
        ?? null;
      if (!product) {
        throw new Error(`Product ${line.productQuery} not found.`);
      }
      return {
        productId: product.id,
        quantity: line.quantity
      };
    })
  );

  return gateway.prepareSalesOrder({
    customerId: customer.id,
    lines: resolvedLines
  });
}

function cloneExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    summary: plan.summary,
    steps: plan.steps.map((step) => ({ ...step }))
  };
}

function markPlanStep(
  step: ExecutionPlan["steps"][number],
  status: ExecutionPlan["steps"][number]["status"],
  detail: string
) {
  step.status = status;
  step.detail = detail;
}

function isDuplicateError(error: unknown) {
  return error instanceof Error && /already exists/i.test(error.message);
}

function formatPlanError(error: unknown) {
  if (!(error instanceof Error)) {
    return "Etapa bloqueada por erro desconhecido.";
  }
  if (/already exists/i.test(error.message)) {
    return "Registro ja existente.";
  }
  if (/Missing customer/i.test(error.message)) {
    return "Cliente nao informado para preparar o pedido.";
  }
  if (/Missing products/i.test(error.message)) {
    return "Produtos nao informados para preparar o pedido.";
  }
  if (/not found/i.test(error.message)) {
    return "Nao encontrei um dos registros necessarios.";
  }
  return "Etapa bloqueada por regra de negocio.";
}

function createPreparedOrderResponse(state: AgentGraphStateValue): AgentResponse {
  const preview = state.preview!;
  const customer = state.customer!;
  const itemSummary = preview.lines
    .map((line: SalesOrderPreview["lines"][number]) => `${line.quantity}x ${line.name}`)
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
      audit("search_product", `Matched products: ${preview.lines.map((line: SalesOrderPreview["lines"][number]) => line.name).join(", ")}.`),
      audit(
        "validate_stock",
        `Validated ${state.stockResults.length} line(s): ${state.stockResults
          .map((stock: StockResult) => `${stock.requested}/${stock.available}`)
          .join(", ")}.`
      ),
      audit("prepare_sales_order", `Prepared preview for ${money(preview.subtotal)}.`)
    ],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createOrderClarificationResponse(state: AgentGraphStateValue): AgentResponse {
  if (state.clarification) {
    return createDisambiguationResponse(state);
  }

  const missingProducts = state.resolvedLines
    .filter((line: ResolvedOrderLine) => !line.product)
    .map((line: ResolvedOrderLine) => line.requested.productQuery);
  const missing = [
    state.customer ? null : "cliente",
    state.requestedLines.length ? null : "produto e quantidade",
    ...missingProducts.map((product: string) => `produto ${product}`)
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

function createCatalogResponse(state: AgentGraphStateValue): AgentResponse {
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

function createProductUpdateResponse(state: AgentGraphStateValue): AgentResponse {
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

  if (state.clarification) {
    return createDisambiguationResponse(state);
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

function createOrderUpdateResponse(state: AgentGraphStateValue): AgentResponse {
  const requested = state.requestedLines[0] as RequestedOrderLine | undefined;
  const resolved = state.resolvedLines[0] as ResolvedOrderLine | undefined;
  const operation = state.orderUpdateOperation as OrderUpdateOperation | null;

  if (!state.lastOrderId) {
    const action = getOrderUpdateActionLabel(operation);
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Ainda nao tenho um pedido confirmado nesta sessao. Crie e confirme um pedido primeiro; depois eu ${action} nele.`
      },
      auditEvents: [audit("order_line_update_blocked", "Order update blocked without an existing order.", "agent")],
      lastOrderId: null
    };
  }

  if (!requested || !operation) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: "Consigo atualizar itens do pedido, mas preciso saber qual produto e a acao desejada."
      },
      auditEvents: [audit("order_line_update_context_required", "Order update blocked without product or action.", "agent")],
      lastOrderId: state.lastOrderId
    };
  }

  if (state.clarification) {
    return createDisambiguationResponse(state);
  }

  if (!resolved?.product) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Nao encontrei um produto chamado ${requested.productQuery}.`
      },
      auditEvents: [audit("order_line_update_product_not_found", `Product ${requested.productQuery} was not found.`, "agent")],
      lastOrderId: state.lastOrderId
    };
  }

  const order = state.existingOrder as SalesOrder | null;
  if (!order) {
    const reason = formatOrderUpdateError(state.orderUpdateError);
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: `Nao consegui atualizar o pedido ${state.lastOrderId}. ${reason} Nenhuma alteracao foi aplicada.`
      },
      auditEvents: [audit("order_line_update_failed", `Failed to update sales order ${state.lastOrderId}.`, "agent")],
      lastOrderId: state.lastOrderId
    };
  }

  const action = getOrderUpdateSuccessText(operation, requested, resolved.product, order);
  const auditAction = getOrderUpdateAuditAction(operation);
  return {
    mode: state.mode,
    order,
    message: {
      id: createId("msg"),
      role: "agent",
      text: action
    },
    auditEvents: [
      audit("search_product", `Matched product ${resolved.product.name}.`),
      audit(auditAction, `Updated ${resolved.product.name} in ${order.id}.`)
    ],
    lastOrderId: order.id
  };
}

function createDisambiguationResponse(state: AgentGraphStateValue): AgentResponse {
  const clarification = state.clarification as ClarificationRequest;
  return {
    mode: state.mode,
    clarification,
    message: {
      id: createId("msg"),
      role: "agent",
      text: `${clarification.question} ${clarification.options
        .map((option, index) => `${index + 1}. ${option.label}${option.description ? ` (${option.description})` : ""}`)
        .join("; ")}.`
    },
    auditEvents: [
      audit(
        "disambiguation_required",
        `Ambiguous ${clarification.kind} query "${clarification.query}" with ${clarification.options.length} option(s).`,
        "agent"
      )
    ],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createExecutionPlanResponse(state: AgentGraphStateValue): AgentResponse {
  const executionPlan = state.executionPlan as ExecutionPlan | null;
  if (!executionPlan) {
    return {
      mode: state.mode,
      message: {
        id: createId("msg"),
        role: "agent",
        text: "Nao consegui montar um plano executavel para essa solicitacao. Tente separar a operacao em etapas menores."
      },
      auditEvents: [audit("execution_plan_failed", "Agent could not build an execution plan.", "agent")],
      lastOrderId: state.lastOrderId ?? null
    };
  }

  const executed = executionPlan.steps.filter((step) => step.status === "executed").length;
  const pending = executionPlan.steps.filter((step) => step.status === "pending_confirmation").length;
  const blocked = executionPlan.steps.filter((step) => step.status === "blocked").length;
  const statusSummary = [
    `${executed} executada(s)`,
    pending ? `${pending} pendente(s) de confirmacao` : null,
    blocked ? `${blocked} bloqueada(s)` : null
  ].filter(Boolean).join(", ");

  return {
    mode: state.mode,
    executionPlan,
    preview: state.preview ?? null,
    invoice: state.invoice ?? null,
    analyticsResult: state.analyticsResult ?? null,
    message: {
      id: createId("msg"),
      role: "agent",
      text: `Montei e executei um plano com ${executionPlan.steps.length} etapa(s): ${statusSummary}.`
    },
    auditEvents: [
      audit("build_execution_plan", `Built plan with ${executionPlan.steps.length} step(s).`),
      audit("execute_execution_plan", `Plan result: ${statusSummary}.`)
    ],
    lastOrderId: state.lastOrderId ?? null
  };
}

function getOrderUpdateActionLabel(operation: OrderUpdateOperation | null) {
  if (operation === "remove") {
    return "removo itens";
  }
  if (operation === "set_quantity") {
    return "ajusto quantidades";
  }
  return "adiciono itens";
}

function getOrderUpdateSuccessText(
  operation: OrderUpdateOperation,
  requested: RequestedOrderLine,
  product: Product,
  order: SalesOrder
) {
  if (operation === "remove") {
    return `Removi ${product.name} do pedido ${order.id}. Novo total: ${money(order.subtotal)}.`;
  }
  if (operation === "set_quantity") {
    return `Alterei a quantidade de ${product.name} no pedido ${order.id} para ${requested.quantity}. Novo total: ${money(order.subtotal)}.`;
  }
  return `Adicionei ${requested.quantity}x ${product.name} ao pedido ${order.id}. Novo total: ${money(order.subtotal)}.`;
}

function getOrderUpdateAuditAction(operation: OrderUpdateOperation) {
  if (operation === "remove") {
    return "remove_sales_order_line";
  }
  if (operation === "set_quantity") {
    return "set_sales_order_line_quantity";
  }
  return "add_sales_order_line";
}

function formatOrderUpdateError(error: string | null | undefined) {
  if (!error) {
    return "";
  }
  if (/must keep at least one item/i.test(error)) {
    return "O pedido precisa manter pelo menos um item.";
  }
  if (/has only/i.test(error)) {
    return "Nao ha estoque suficiente para essa quantidade.";
  }
  if (/is not in sales order/i.test(error)) {
    return "Esse produto nao esta no pedido informado.";
  }
  return "A regra de negocio bloqueou a operacao.";
}

function createInvoiceResponse(state: AgentGraphStateValue): AgentResponse {
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

function createOrdersListResponse(state: AgentGraphStateValue): AgentResponse {
  const orders = state.recentOrders;
  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: orders.length
        ? `Encontrei ${orders.length} pedido(s) recentes: ${orders
            .map((order: SalesOrder) => `${order.id} para ${order.customer.name}`)
            .join(", ")}.`
        : "Ainda nao ha pedidos confirmados nesta sessao demo."
    },
    auditEvents: [audit("list_recent_orders", "Listed recent sales orders.")],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createInventoryDiagnosticResponse(state: AgentGraphStateValue): AgentResponse {
  const products = state.lowStockProducts;
  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: products.length
        ? `Encontrei ${products.length} produto(s) com estoque baixo: ${products
            .map((product: Product) => `${product.name} (${product.availableStock} un.)`)
            .join(", ")}. Sugestao: priorize reposicao dos itens com menor saldo antes de aceitar pedidos maiores.`
        : "Nao encontrei produtos com estoque baixo considerando o limite de 10 unidades."
    },
    auditEvents: [audit("list_low_stock_products", "Diagnosed low stock products.")],
    lastOrderId: state.lastOrderId ?? null
  };
}

function createTraditionalFlowResponse(state: AgentGraphStateValue): AgentResponse {
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

function createUnknownResponse(state: AgentGraphStateValue): AgentResponse {
  return {
    mode: state.mode,
    message: {
      id: createId("msg"),
      role: "agent",
      text: buildClarifyingFallbackQuestion(state.message)
    },
    auditEvents: [audit("clarification_required", "Agent asked a follow-up question for an unmapped message.", "agent")],
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

function createAnalyticsResponse(state: AgentGraphStateValue): AgentResponse {
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

function createAnalyticsClarificationResponse(state: AgentGraphStateValue): AgentResponse {
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
        : dateRange === "last_30_days"
          ? "nos ultimos 30 dias"
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
  return `${base} ${groupLabel}: ${rowSummary}. ${formatAnalyticsExplanation(metric, rows)}`;
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

function formatAnalyticsExplanation(metric: AnalyticsMetric, rows: Array<{ label: string; value: number }>) {
  const leader = rows[0];
  if (!leader) {
    return "";
  }
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const share = total > 0 ? Math.round((leader.value / total) * 100) : 0;
  const metricLabel =
    metric === "revenue"
      ? "do faturamento analisado"
      : metric === "order_count"
        ? "dos pedidos analisados"
        : "das unidades analisadas";
  return `${leader.label} lidera com ${formatAnalyticsRowMetric(metric, leader.value)}, representando ${share}% ${metricLabel}.`;
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
