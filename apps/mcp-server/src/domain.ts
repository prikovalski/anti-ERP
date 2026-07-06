import {
  AuditEvent,
  ConceptInvoice,
  CreateConceptInvoiceInputSchema,
  CreateSalesOrderInputSchema,
  GetSalesOrderInputSchema,
  PrepareSalesOrderInputSchema,
  SalesOrder,
  SearchCustomerInputSchema,
  SearchProductInputSchema,
  ValidateStockInputSchema
} from "@anti-erp/shared";
import { customers, products } from "./seed.js";

const auditEvents: AuditEvent[] = [];
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
  const normalized = query.toLowerCase();
  const matches = customers.filter(
    (customer) =>
      customer.name.toLowerCase().includes(normalized) ||
      customer.taxId.includes(query)
  );
  audit("search_customer", `Searched customer "${query}"`, { resultCount: matches.length });
  return matches;
}

export function searchProduct(input: unknown) {
  const { query } = SearchProductInputSchema.parse(input);
  const normalized = query.toLowerCase();
  const matches = products.filter(
    (product) =>
      product.name.toLowerCase().includes(normalized) ||
      product.sku.toLowerCase().includes(normalized)
  );
  audit("search_product", `Searched product "${query}"`, { resultCount: matches.length });
  return matches;
}

export function validateStock(input: unknown) {
  const { productId, quantity } = ValidateStockInputSchema.parse(input);
  const product = products.find((candidate) => candidate.id === productId);
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
  const customer = customers.find((candidate) => candidate.id === customerId);
  if (!customer) {
    throw new Error(`Customer ${customerId} not found.`);
  }

  const warnings: string[] = [];
  if (customer.status === "blocked") {
    warnings.push("Customer is blocked. Human review is required before confirmation.");
  }

  const orderLines = lines.map((line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
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

export function getAuditTimeline() {
  return auditEvents.slice(0, 25);
}
