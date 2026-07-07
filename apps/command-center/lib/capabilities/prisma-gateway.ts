import {
  ConceptInvoice,
  Customer,
  Product,
  SalesOrder,
  SalesOrderLine,
  SalesOrderPreview,
  demoCustomers,
  demoProducts
} from "@anti-erp/shared";
import { Prisma, PrismaClient } from "@prisma/client";
import type { CapabilityGateway } from "./types";

type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type DbCustomer = {
  id: string;
  name: string;
  taxId: string;
  city: string;
  status: "active" | "blocked";
};

type DbProduct = {
  id: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  availableStock: number;
};

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

let seedPromise: Promise<void> | null = null;

function ensureSeeded() {
  seedPromise ??= seedDemoData();
  return seedPromise;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toCents(value: number) {
  return Math.round(value * 100);
}

function fromCents(value: number) {
  return value / 100;
}

function mapCustomer(customer: {
  id: string;
  name: string;
  taxId: string;
  city: string;
  status: "active" | "blocked";
}): Customer {
  return customer;
}

function mapProduct(product: {
  id: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  availableStock: number;
}): Product {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    unitPrice: fromCents(product.unitPriceCents),
    availableStock: product.availableStock
  };
}

function mapSalesOrder(order: {
  id: string;
  status: "draft" | "confirmed";
  createdAt: Date;
  customer: {
    id: string;
    name: string;
    taxId: string;
    city: string;
    status: "active" | "blocked";
  };
  lines: Array<{
    productId: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    product: {
      sku: string;
      name: string;
    };
  }>;
}): SalesOrder {
  const lines: SalesOrderLine[] = order.lines.map((line) => ({
    productId: line.productId,
    sku: line.product.sku,
    name: line.product.name,
    quantity: line.quantity,
    unitPrice: fromCents(line.unitPriceCents),
    total: fromCents(line.totalCents)
  }));

  return {
    id: order.id,
    customer: mapCustomer(order.customer),
    lines,
    subtotal: lines.reduce((sum, line) => sum + line.total, 0),
    warnings: [],
    confirmationRequired: true,
    status: order.status,
    createdAt: order.createdAt.toISOString()
  };
}

async function audit(action: string, summary: string, metadata?: Prisma.InputJsonObject) {
  await prisma.auditEvent.create({
    data: {
      actor: "mcp-tool",
      action,
      summary,
      metadata
    }
  });
}

async function seedDemoData() {
  await Promise.all([
    ...demoCustomers.map((customer) =>
      prisma.customer.upsert({
        where: { id: customer.id },
        update: {
          name: customer.name,
          taxId: customer.taxId,
          city: customer.city,
          status: customer.status
        },
        create: customer
      })
    ),
    ...demoProducts.map((product) =>
      prisma.product.upsert({
        where: { id: product.id },
        update: {
          sku: product.sku,
          name: product.name,
          unitPriceCents: toCents(product.unitPrice),
          availableStock: product.availableStock
        },
        create: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          unitPriceCents: toCents(product.unitPrice),
          availableStock: product.availableStock
        }
      })
    ),
    prisma.sequenceCounter.upsert({
      where: { name: "sales_order" },
      update: {},
      create: {
        name: "sales_order",
        nextValue: 1001
      }
    }),
    prisma.sequenceCounter.upsert({
      where: { name: "concept_invoice" },
      update: {},
      create: {
        name: "concept_invoice",
        nextValue: 5001
      }
    })
  ]);
}

async function nextBusinessId(
  tx: PrismaTransaction,
  name: string,
  prefix: string,
  startAt: number
) {
  const counter = await tx.sequenceCounter.upsert({
    where: { name },
    create: {
      name,
      nextValue: startAt + 1
    },
    update: {
      nextValue: {
        increment: 1
      }
    }
  });
  return `${prefix}-${counter.nextValue - 1}`;
}

export class PrismaCapabilityGateway implements CapabilityGateway {
  async searchCustomer(input: { query: string }) {
    await ensureSeeded();
    const query = normalize(input.query);
    const customers = (await prisma.customer.findMany()) as DbCustomer[];
    const matches = customers.filter(
      (customer) => normalize(customer.name).includes(query) || customer.taxId.includes(input.query)
    );
    await audit("search_customer", `Searched customer "${input.query}"`, { resultCount: matches.length });
    return matches.map(mapCustomer);
  }

  async searchProduct(input: { query: string }) {
    await ensureSeeded();
    const query = normalize(input.query);
    const products = (await prisma.product.findMany()) as DbProduct[];
    const matches = products.filter(
      (product) => normalize(product.name).includes(query) || normalize(product.sku).includes(query)
    );
    await audit("search_product", `Searched product "${input.query}"`, { resultCount: matches.length });
    return matches.map(mapProduct);
  }

  async validateStock(input: { productId: string; quantity: number }) {
    await ensureSeeded();
    const product = (await prisma.product.findUniqueOrThrow({
      where: { id: input.productId }
    })) as DbProduct;
    const valid = product.availableStock >= input.quantity;
    await audit("validate_stock", `Validated stock for ${product.sku}`, {
      requested: input.quantity,
      available: product.availableStock,
      valid
    });
    return {
      productId: product.id,
      requested: input.quantity,
      available: product.availableStock,
      valid
    };
  }

  async prepareSalesOrder(input: {
    customerId: string;
    lines: Array<{ productId: string; quantity: number }>;
  }) {
    await ensureSeeded();
    const customer = (await prisma.customer.findUniqueOrThrow({
      where: { id: input.customerId }
    })) as DbCustomer;
    const products = (await prisma.product.findMany({
      where: {
        id: {
          in: input.lines.map((line) => line.productId)
        }
      }
    })) as DbProduct[];

    const warnings: string[] = [];
    if (customer.status === "blocked") {
      warnings.push("Customer is blocked. Human review is required before confirmation.");
    }

    const orderLines = input.lines.map((line) => {
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
        unitPrice: fromCents(product.unitPriceCents),
        total: fromCents(product.unitPriceCents) * line.quantity
      };
    });

    const preview: SalesOrderPreview = {
      customer: mapCustomer(customer),
      lines: orderLines,
      subtotal: orderLines.reduce((sum, line) => sum + line.total, 0),
      warnings,
      confirmationRequired: true
    };

    await audit("prepare_sales_order", `Prepared sales order preview for ${customer.name}`, {
      subtotal: preview.subtotal,
      warningCount: warnings.length
    });
    return preview;
  }

  async createSalesOrder(input: { preview: SalesOrderPreview; confirmedByUser: true }) {
    await ensureSeeded();
    const order = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const id = await nextBusinessId(tx, "sales_order", "SO", 1001);
      return tx.salesOrder.create({
        data: {
          id,
          customerId: input.preview.customer.id,
          status: "confirmed",
          lines: {
            create: input.preview.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPriceCents: toCents(line.unitPrice),
              totalCents: toCents(line.total)
            }))
          }
        },
        include: {
          customer: true,
          lines: {
            include: {
              product: true
            }
          }
        }
      });
    });

    await audit("create_sales_order", `Created sales order ${order.id}`, {
      customerId: order.customerId
    });
    return mapSalesOrder(order);
  }

  async createConceptInvoice(input: { salesOrderId: string }) {
    await ensureSeeded();
    const invoice = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: input.salesOrderId },
        include: {
          lines: true,
          customer: true
        }
      });
      const id = await nextBusinessId(tx, "concept_invoice", "CI", 5001);
      return tx.conceptInvoice.create({
        data: {
          id,
          salesOrderId: order.id,
          amountCents: order.lines.reduce((sum: number, line: { totalCents: number }) => sum + line.totalCents, 0),
          disclaimer: "Concept invoice for portfolio demo only. Not a fiscal document."
        },
        include: {
          salesOrder: {
            include: {
              customer: true
            }
          }
        }
      });
    });

    const conceptInvoice: ConceptInvoice = {
      id: invoice.id,
      salesOrderId: invoice.salesOrderId,
      customerName: invoice.salesOrder.customer.name,
      amount: fromCents(invoice.amountCents),
      issuedAt: invoice.issuedAt.toISOString(),
      disclaimer: invoice.disclaimer
    };

    await audit("create_concept_invoice", `Created concept invoice ${invoice.id}`, {
      salesOrderId: invoice.salesOrderId,
      amount: conceptInvoice.amount
    });
    return conceptInvoice;
  }

  async getSalesOrder(input: { salesOrderId: string }) {
    await ensureSeeded();
    const order = await prisma.salesOrder.findUnique({
      where: { id: input.salesOrderId },
      include: {
        customer: true,
        lines: {
          include: {
            product: true
          }
        }
      }
    });
    await audit("get_sales_order", `Fetched sales order ${input.salesOrderId}`);
    return order ? mapSalesOrder(order) : null;
  }

  async listRecentOrders() {
    await ensureSeeded();
    const orders = await prisma.salesOrder.findMany({
      orderBy: {
        createdAt: "desc"
      },
      take: 10,
      include: {
        customer: true,
        lines: {
          include: {
            product: true
          }
        }
      }
    });
    await audit("list_recent_orders", "Listed recent sales orders");
    return orders.map(mapSalesOrder);
  }

  async getTraditionalErpFlow() {
    await audit("get_traditional_erp_flow", "Compared traditional ERP flow with anti-ERP flow");
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
    await ensureSeeded();
    const range = resolveDateRange(input.dateRange);
    const productQuery = normalize(input.productQuery ?? "");
    const customerQuery = normalize(input.customerQuery ?? "");
    const orders = await prisma.salesOrder.findMany({
      where: range
        ? {
            createdAt: {
              gte: range.start,
              lt: range.end
            }
          }
        : undefined,
      include: {
        customer: true,
        lines: {
          include: {
            product: true
          }
        }
      }
    });

    const filteredOrders = orders.filter((order) => {
      const matchesCustomer = customerQuery ? normalize(order.customer.name).includes(customerQuery) : true;
      const matchesProduct = productQuery
        ? order.lines.some(
            (line) =>
              normalize(line.product.name).includes(productQuery) ||
              normalize(line.product.sku).includes(productQuery)
          )
        : true;
      return matchesCustomer && matchesProduct;
    });

    const filteredLines = filteredOrders.flatMap((order) =>
      order.lines.filter((line) =>
        productQuery
          ? normalize(line.product.name).includes(productQuery) || normalize(line.product.sku).includes(productQuery)
          : true
      )
    );

    const value =
      input.metric === "units_sold"
        ? filteredLines.reduce((sum, line) => sum + line.quantity, 0)
        : input.metric === "revenue"
          ? fromCents(filteredLines.reduce((sum, line) => sum + line.totalCents, 0))
          : filteredOrders.length;

    const rows = buildMetricRows(input.groupBy, input.metric, filteredOrders);
    await audit("query_sales_metrics", `Queried ${input.metric} for ${input.dateRange}`, {
      metric: input.metric,
      productQuery: input.productQuery ?? null,
      customerQuery: input.customerQuery ?? null,
      dateRange: input.dateRange,
      value
    });

    return {
      metric: input.metric,
      value,
      label: buildMetricLabel(input.metric, input.productQuery, input.dateRange),
      rows
    };
  }
}

function resolveDateRange(dateRange: "today" | "last_7_days" | "month_to_date" | "all_time") {
  if (dateRange === "all_time") {
    return null;
  }

  const now = new Date();
  const start = new Date(now);
  if (dateRange === "today") {
    start.setHours(0, 0, 0, 0);
  }
  if (dateRange === "last_7_days") {
    start.setDate(start.getDate() - 7);
  }
  if (dateRange === "month_to_date") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }

  return {
    start,
    end: now
  };
}

function buildMetricLabel(metric: string, productQuery: string | null | undefined, dateRange: string) {
  const subject = productQuery ? productQuery : "sales";
  const period = dateRange === "today" ? "today" : dateRange.replaceAll("_", " ");
  return `${metric.replaceAll("_", " ")} for ${subject} ${period}`;
}

function buildMetricRows(
  groupBy: "product" | "customer" | "day" | null | undefined,
  metric: "units_sold" | "revenue" | "order_count",
  orders: Array<{
    createdAt: Date;
    customer: { name: string };
    lines: Array<{
      quantity: number;
      totalCents: number;
      product: { name: string };
    }>;
  }>
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
          ? [{ label: order.createdAt.toISOString().slice(0, 10), lines: order.lines }]
          : order.lines.map((line) => ({ label: line.product.name, lines: [line] }));

    for (const item of labels) {
      const increment =
        metric === "units_sold"
          ? item.lines.reduce((sum, line) => sum + line.quantity, 0)
          : metric === "revenue"
            ? fromCents(item.lines.reduce((sum, line) => sum + line.totalCents, 0))
            : 1;
      rows.set(item.label, (rows.get(item.label) ?? 0) + increment);
    }
  }

  return Array.from(rows.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}
