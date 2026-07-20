import {
  AuditEvent,
  ConceptInvoice,
  CreateCustomerInputSchema,
  CreateConceptInvoiceInputSchema,
  CreateProductInputSchema,
  CreateSalesOrderInputSchema,
  CreateSupplierInputSchema,
  GetSalesOrderInputSchema,
  PrepareSalesOrderInputSchema,
  QuerySalesMetricsInputSchema,
  SalesOrder,
  SearchCustomerInputSchema,
  SearchProductInputSchema,
  Supplier,
  UpdateProductInputSchema,
  ValidateStockInputSchema
} from "@anti-erp/shared";
import { customers, products } from "./seed.js";

const auditEvents: AuditEvent[] = [];
const catalogCustomers = [...customers];
const catalogProducts = [...products];
const catalogSuppliers = new Map<string, Supplier>();
const salesOrders = new Map<string, SalesOrder>();
const conceptInvoices = new Map<string, ConceptInvoice>();
let nextAuditNumber = 1;
let nextSalesOrderNumber = 1001;
let nextConceptInvoiceNumber = 5001;

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${nextAuditNumber++}`;
}

function createSalesOrderId() {
  return `SO-${nextSalesOrderNumber++}`;
}

function createConceptInvoiceId() {
  return `CI-${nextConceptInvoiceNumber++}`;
}

function createCatalogToken() {
  return Math.random().toString(36).slice(2, 8);
}

function cleanName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function slugify(value: string) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 28);
}

function audit(action: string, summary: string, metadata?: Record<string, unknown>) {
  const event: AuditEvent = {
    id: createId("aud"),
    timestamp: now(),
    actor: "mcp-tool",
    action,
    summary,
    metadata
  };
  auditEvents.unshift(event);
  return event;
}

export function searchCustomer(input: unknown) {
  const { query } = SearchCustomerInputSchema.parse(input);
  const normalized = normalize(query);
  const matches = catalogCustomers.filter(
    (customer) =>
      normalize(customer.name).includes(normalized) ||
      customer.taxId.includes(query)
  );
  audit("search_customer", `Searched customer "${query}"`, { resultCount: matches.length });
  return matches;
}

export function searchProduct(input: unknown) {
  const { query } = SearchProductInputSchema.parse(input);
  const normalized = normalize(query);
  const matches = catalogProducts.filter(
    (product) =>
      normalize(product.name).includes(normalized) ||
      normalize(product.sku).includes(normalized)
  );
  audit("search_product", `Searched product "${query}"`, { resultCount: matches.length });
  return matches;
}

export function createCustomer(input: unknown) {
  const { name: rawName } = CreateCustomerInputSchema.parse(input);
  const name = cleanName(rawName);
  const normalizedName = normalize(name);
  const existing = catalogCustomers.find((customer) => normalize(customer.name) === normalizedName);
  if (existing) {
    throw new Error(`Customer "${existing.name}" already exists.`);
  }
  const customer = {
    id: `cus_${slugify(name) || "customer"}_${createCatalogToken()}`,
    name,
    taxId: `DEMO-CUS-${Date.now()}-${createCatalogToken().toUpperCase()}`,
    city: "Nao informada",
    status: "active" as const
  };
  catalogCustomers.push(customer);
  audit("create_customer", `Created customer ${customer.name}`, { customerId: customer.id });
  return customer;
}

export function createProduct(input: unknown) {
  const { name: rawName } = CreateProductInputSchema.parse(input);
  const name = cleanName(rawName);
  const normalizedName = normalize(name);
  const existing = catalogProducts.find((product) => normalize(product.name) === normalizedName);
  if (existing) {
    throw new Error(`Product "${existing.name}" already exists.`);
  }
  const product = {
    id: `prd_${slugify(name) || "product"}_${createCatalogToken()}`,
    sku: `SKU-${slugify(name).replaceAll("_", "-").toUpperCase() || "ITEM"}-${createCatalogToken().toUpperCase()}`,
    name,
    unitPrice: 0,
    availableStock: 0
  };
  catalogProducts.push(product);
  audit("create_product", `Created product ${product.name}`, { productId: product.id });
  return product;
}

export function createSupplier(input: unknown) {
  const { name: rawName } = CreateSupplierInputSchema.parse(input);
  const name = cleanName(rawName);
  const normalizedName = normalize(name);
  const existing = Array.from(catalogSuppliers.values()).find((supplier) => normalize(supplier.name) === normalizedName);
  if (existing) {
    throw new Error(`Supplier "${existing.name}" already exists.`);
  }
  const supplier = {
    id: `sup_${slugify(name) || "supplier"}_${createCatalogToken()}`,
    name,
    status: "active" as const
  };
  catalogSuppliers.set(supplier.id, supplier);
  audit("create_supplier", `Created supplier ${supplier.name}`, { supplierId: supplier.id });
  return supplier;
}

export function updateProduct(input: unknown) {
  const params = UpdateProductInputSchema.parse(input);
  const product = catalogProducts.find((candidate) => candidate.id === params.productId);
  if (!product) {
    throw new Error(`Product ${params.productId} not found.`);
  }
  if (params.unitPrice !== undefined && params.unitPrice !== null) {
    product.unitPrice = params.unitPrice;
  }
  if (params.availableStock !== undefined && params.availableStock !== null) {
    product.availableStock = params.availableStock;
  }
  audit("update_product", `Updated product ${product.name}`, {
    productId: product.id,
    unitPrice: params.unitPrice ?? null,
    availableStock: params.availableStock ?? null
  });
  return product;
}

export function validateStock(input: unknown) {
  const { productId, quantity } = ValidateStockInputSchema.parse(input);
  const product = catalogProducts.find((candidate) => candidate.id === productId);
  if (!product) {
    throw new Error(`Product ${productId} not found.`);
  }
  const valid = product.availableStock >= quantity;
  audit("validate_stock", `Validated stock for ${product.sku}`, {
    requested: quantity,
    available: product.availableStock,
    valid
  });
  return {
    productId,
    requested: quantity,
    available: product.availableStock,
    valid
  };
}

export function prepareSalesOrder(input: unknown) {
  const { customerId, lines } = PrepareSalesOrderInputSchema.parse(input);
  const customer = catalogCustomers.find((candidate) => candidate.id === customerId);
  if (!customer) {
    throw new Error(`Customer ${customerId} not found.`);
  }

  const warnings: string[] = [];
  if (customer.status === "blocked") {
    warnings.push("Customer is blocked. Human review is required before confirmation.");
  }

  const orderLines = lines.map((line) => {
    const product = catalogProducts.find((candidate) => candidate.id === line.productId);
    if (!product) {
      throw new Error(`Product ${line.productId} not found.`);
    }
    if (product.availableStock < line.quantity) {
      warnings.push(`${product.sku} has only ${product.availableStock} units available.`);
    }
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      quantity: line.quantity,
      unitPrice: product.unitPrice,
      total: product.unitPrice * line.quantity
    };
  });

  const preview = {
    customer,
    lines: orderLines,
    subtotal: orderLines.reduce((sum, line) => sum + line.total, 0),
    warnings,
    confirmationRequired: true as const
  };

  audit("prepare_sales_order", `Prepared sales order preview for ${customer.name}`, {
    subtotal: preview.subtotal,
    warningCount: warnings.length
  });
  return preview;
}

export function createSalesOrder(input: unknown) {
  const { preview } = CreateSalesOrderInputSchema.parse(input);
  const order: SalesOrder = {
    ...preview,
    id: createSalesOrderId(),
    status: "confirmed",
    createdAt: now()
  };
  salesOrders.set(order.id, order);
  audit("create_sales_order", `Created sales order ${order.id}`, {
    customerId: order.customer.id,
    subtotal: order.subtotal
  });
  return order;
}

export function createConceptInvoice(input: unknown) {
  const { salesOrderId } = CreateConceptInvoiceInputSchema.parse(input);
  const order = salesOrders.get(salesOrderId);
  if (!order) {
    throw new Error(`Sales order ${salesOrderId} not found.`);
  }
  const invoice: ConceptInvoice = {
    id: createConceptInvoiceId(),
    salesOrderId,
    customerName: order.customer.name,
    amount: order.subtotal,
    issuedAt: now(),
    disclaimer: "Concept invoice for portfolio demo only. Not a fiscal document."
  };
  conceptInvoices.set(invoice.id, invoice);
  audit("create_concept_invoice", `Created concept invoice ${invoice.id}`, {
    salesOrderId,
    amount: invoice.amount
  });
  return invoice;
}

export function getSalesOrder(input: unknown) {
  const { salesOrderId } = GetSalesOrderInputSchema.parse(input);
  audit("get_sales_order", `Fetched sales order ${salesOrderId}`);
  return salesOrders.get(salesOrderId) ?? null;
}

export function listRecentOrders() {
  audit("list_recent_orders", "Listed recent sales orders");
  return Array.from(salesOrders.values()).slice(-10).reverse();
}

export function getTraditionalErpFlow() {
  audit("get_traditional_erp_flow", "Compared traditional ERP flow with anti-ERP flow");
  return {
    traditional: [
      "Open customer module",
      "Search legal entity",
      "Open sales order module",
      "Create header",
      "Add items line by line",
      "Check stock manually",
      "Save order",
      "Open invoice module",
      "Generate invoice"
    ],
    antiErp: [
      "Say the business intent",
      "Agent resolves customer and products",
      "MCP tools validate stock and prepare a preview",
      "User confirms",
      "MCP tools create the order and concept invoice",
      "Timeline records every relevant action"
    ]
  };
}

export function querySalesMetrics(input: unknown) {
  const params = QuerySalesMetricsInputSchema.parse(input);
  const productQuery = normalize(params.productQuery ?? "");
  const customerQuery = normalize(params.customerQuery ?? "");
  const filteredOrders = Array.from(salesOrders.values()).filter((order) => {
    const matchesDateRange = isInsideDateRange(order.createdAt, params.dateRange);
    const matchesCustomer = customerQuery ? normalize(order.customer.name).includes(customerQuery) : true;
    const matchesProduct = productQuery
      ? order.lines.some((line) => normalize(line.name).includes(productQuery) || normalize(line.sku).includes(productQuery))
      : true;
    return matchesDateRange && matchesCustomer && matchesProduct;
  });
  const filteredLines = filteredOrders.flatMap((order) =>
    order.lines.filter((line) =>
      productQuery ? normalize(line.name).includes(productQuery) || normalize(line.sku).includes(productQuery) : true
    )
  );
  const value =
    params.metric === "units_sold"
      ? filteredLines.reduce((sum, line) => sum + line.quantity, 0)
      : params.metric === "revenue"
        ? filteredLines.reduce((sum, line) => sum + line.total, 0)
        : filteredOrders.length;

  audit("query_sales_metrics", `Queried ${params.metric} for ${params.dateRange}`, {
    metric: params.metric,
    productQuery: params.productQuery ?? null,
    customerQuery: params.customerQuery ?? null,
    dateRange: params.dateRange,
    value
  });

  return {
    metric: params.metric,
    value,
    label: buildMetricLabel(params.metric, params.productQuery, params.dateRange),
    query: buildAnalyticsQuery({
      ...params,
      dataSource: "mcp-memory"
    }),
    rows: buildMetricRows(params.groupBy, params.metric, filteredOrders)
  };
}

export function getAuditTimeline() {
  return auditEvents.slice(0, 25);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isInsideDateRange(createdAt: string, dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time") {
  if (dateRange === "all_time") {
    return true;
  }

  const date = new Date(createdAt);
  const nowDate = new Date();
  const start = new Date(nowDate);
  if (dateRange === "today") {
    start.setHours(0, 0, 0, 0);
  }
  if (dateRange === "last_7_days") {
    start.setDate(start.getDate() - 7);
  }
  if (dateRange === "last_30_days") {
    start.setDate(start.getDate() - 30);
  }
  if (dateRange === "month_to_date") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }
  return date >= start && date < nowDate;
}

function buildMetricLabel(metric: string, productQuery: string | null | undefined, dateRange: string) {
  const subject = productQuery ? productQuery : "sales";
  const period = dateRange === "today" ? "today" : dateRange.replaceAll("_", " ");
  return `${metric.replaceAll("_", " ")} for ${subject} ${period}`;
}

function buildAnalyticsQuery(input: {
  productQuery?: string | null;
  customerQuery?: string | null;
  dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time";
  groupBy?: "product" | "customer" | "day" | null;
  dataSource: "mcp-memory";
}) {
  return {
    capability: "query_sales_metrics" as const,
    entities: ["sales_orders", "sales_order_lines", "customers", "products"],
    filters: [
      { label: "period", value: input.dateRange.replaceAll("_", " ") },
      input.productQuery ? { label: "product", value: input.productQuery } : null,
      input.customerQuery ? { label: "customer", value: input.customerQuery } : null
    ].filter((filter): filter is { label: string; value: string } => Boolean(filter)),
    groupBy: input.groupBy ?? null,
    dateRange: input.dateRange,
    dataSource: input.dataSource
  };
}

function buildMetricRows(
  groupBy: "product" | "customer" | "day" | null | undefined,
  metric: "units_sold" | "revenue" | "order_count",
  orders: SalesOrder[]
) {
  if (!groupBy) {
    return [];
  }

  const rows = new Map<string, number>();
  for (const order of orders) {
    const labels =
      groupBy === "customer"
        ? [{ label: order.customer.name, lines: order.lines }]
        : groupBy === "day"
          ? [{ label: order.createdAt.slice(0, 10), lines: order.lines }]
          : order.lines.map((line) => ({ label: line.name, lines: [line] }));

    for (const item of labels) {
      const increment =
        metric === "units_sold"
          ? item.lines.reduce((sum, line) => sum + line.quantity, 0)
          : metric === "revenue"
            ? item.lines.reduce((sum, line) => sum + line.total, 0)
            : 1;
      rows.set(item.label, (rows.get(item.label) ?? 0) + increment);
    }
  }

  return Array.from(rows.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}
