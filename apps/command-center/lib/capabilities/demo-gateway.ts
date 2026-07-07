import {
  ConceptInvoice,
  SalesOrder,
  SalesOrderPreview,
  demoCustomers,
  demoProducts
} from "@anti-erp/shared";
import type { CapabilityGateway } from "./types";

const salesOrders = new Map<string, SalesOrder>();
const invoices = new Map<string, ConceptInvoice>();
let nextSalesOrderNumber = 1001;
let nextConceptInvoiceNumber = 5001;

function now() {
  return new Date().toISOString();
}

function createSalesOrderId() {
  return `SO-${nextSalesOrderNumber++}`;
}

function createConceptInvoiceId() {
  return `CI-${nextConceptInvoiceNumber++}`;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export class DemoCapabilityGateway implements CapabilityGateway {
  async searchCustomer(input: { query: string }) {
    const query = normalize(input.query);
    return demoCustomers.filter(
      (customer) => normalize(customer.name).includes(query) || customer.taxId.includes(input.query)
    );
  }

  async searchProduct(input: { query: string }) {
    const query = normalize(input.query);
    return demoProducts.filter(
      (product) => normalize(product.name).includes(query) || normalize(product.sku).includes(query)
    );
  }

  async validateStock(input: { productId: string; quantity: number }) {
    const product = demoProducts.find((candidate) => candidate.id === input.productId);
    if (!product) {
      throw new Error(`Product ${input.productId} not found.`);
    }

    return {
      productId: product.id,
      requested: input.quantity,
      available: product.availableStock,
      valid: product.availableStock >= input.quantity
    };
  }

  async prepareSalesOrder(input: {
    customerId: string;
    lines: Array<{ productId: string; quantity: number }>;
  }) {
    const customer = demoCustomers.find((candidate) => candidate.id === input.customerId);
    if (!customer) {
      throw new Error(`Customer ${input.customerId} not found.`);
    }

    const warnings: string[] = [];
    if (customer.status === "blocked") {
      warnings.push("Customer is blocked. Human review is required before confirmation.");
    }

    const lines = input.lines.map((line) => {
      const product = demoProducts.find((candidate) => candidate.id === line.productId);
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

    return {
      customer,
      lines,
      subtotal: lines.reduce((sum, line) => sum + line.total, 0),
      warnings,
      confirmationRequired: true as const
    };
  }

  async createSalesOrder(input: { preview: SalesOrderPreview; confirmedByUser: true }) {
    const order: SalesOrder = {
      ...input.preview,
      id: createSalesOrderId(),
      status: "confirmed",
      createdAt: now()
    };
    salesOrders.set(order.id, order);
    return order;
  }

  async createConceptInvoice(input: { salesOrderId: string }) {
    const order = salesOrders.get(input.salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }

    const invoice: ConceptInvoice = {
      id: createConceptInvoiceId(),
      salesOrderId: order.id,
      customerName: order.customer.name,
      amount: order.subtotal,
      issuedAt: now(),
      disclaimer: "Concept invoice for portfolio demo only. Not a fiscal document."
    };
    invoices.set(invoice.id, invoice);
    return invoice;
  }

  async getSalesOrder(input: { salesOrderId: string }) {
    return salesOrders.get(input.salesOrderId) ?? null;
  }

  async listRecentOrders() {
    return Array.from(salesOrders.values()).slice(-10).reverse();
  }

  async getTraditionalErpFlow() {
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

  async querySalesMetrics(input: {
    metric: "units_sold" | "revenue" | "order_count";
    productQuery?: string | null;
    customerQuery?: string | null;
    dateRange: "today" | "last_7_days" | "month_to_date" | "all_time";
    groupBy?: "product" | "customer" | "day" | null;
  }) {
    const query = normalize(input.productQuery ?? "");
    const customerQuery = normalize(input.customerQuery ?? "");
    const filteredOrders = Array.from(salesOrders.values()).filter((order) => {
      const matchesCustomer = customerQuery ? normalize(order.customer.name).includes(customerQuery) : true;
      const matchesProduct = query
        ? order.lines.some((line) => normalize(line.name).includes(query) || normalize(line.sku).includes(query))
        : true;
      return matchesCustomer && matchesProduct;
    });

    const matchingLines = filteredOrders.flatMap((order) =>
      order.lines.filter((line) =>
        query ? normalize(line.name).includes(query) || normalize(line.sku).includes(query) : true
      )
    );
    const value =
      input.metric === "units_sold"
        ? matchingLines.reduce((sum, line) => sum + line.quantity, 0)
        : input.metric === "revenue"
          ? matchingLines.reduce((sum, line) => sum + line.total, 0)
          : filteredOrders.length;

    return {
      metric: input.metric,
      value,
      label: buildMetricLabel(input.metric, input.productQuery, input.dateRange),
      rows: []
    };
  }
}

export const demoCapabilityGateway = new DemoCapabilityGateway();

function buildMetricLabel(metric: string, productQuery: string | null | undefined, dateRange: string) {
  const subject = productQuery ? productQuery : "sales";
  const period = dateRange === "today" ? "today" : dateRange.replaceAll("_", " ");
  return `${metric.replaceAll("_", " ")} for ${subject} ${period}`;
}
