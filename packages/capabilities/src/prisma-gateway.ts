import {
  AnalyticsResult,
  ConceptInvoice,
  Customer,
  ListSalesOrdersInput,
  Product,
  SalesOrder,
  SalesOrderLine,
  SalesOrderPreview,
  Supplier,
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

type DbSupplier = {
  id: string;
  name: string;
  status: "active" | "blocked";
};

type RawSalesOrderRow = {
  order_id: string;
  order_status: string;
  order_created_at: Date;
  customer_id: string;
  customer_name: string;
  customer_tax_id: string;
  customer_city: string;
  customer_status: "active" | "blocked";
  product_id: string | null;
  product_sku: string | null;
  product_name: string | null;
  line_quantity: number | null;
  line_unit_price_cents: number | null;
  line_total_cents: number | null;
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
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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

function randomToken() {
  return Math.random().toString(36).slice(2, 8);
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

function mapSupplier(supplier: {
  id: string;
  name: string;
  status: "active" | "blocked";
}): Supplier {
  return supplier;
}

function mapSalesOrder(order: {
  id: string;
  status: "draft" | "confirmed" | "canceled";
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

function mapRawSalesOrderRows(rows: RawSalesOrderRow[]): SalesOrder[] {
  const orders = new Map<string, SalesOrder>();
  for (const row of rows) {
    if (!orders.has(row.order_id)) {
      orders.set(row.order_id, {
        id: row.order_id,
        customer: {
          id: row.customer_id,
          name: row.customer_name,
          taxId: row.customer_tax_id,
          city: row.customer_city,
          status: row.customer_status
        },
        lines: [],
        subtotal: 0,
        warnings: [],
        confirmationRequired: true,
        status: row.order_status as SalesOrder["status"],
        createdAt: row.order_created_at.toISOString()
      });
    }

    const order = orders.get(row.order_id)!;
    if (row.product_id && row.product_sku && row.product_name && row.line_quantity !== null) {
      order.lines.push({
        productId: row.product_id,
        sku: row.product_sku,
        name: row.product_name,
        quantity: row.line_quantity,
        unitPrice: fromCents(row.line_unit_price_cents ?? 0),
        total: fromCents(row.line_total_cents ?? 0)
      });
    }
  }

  for (const order of orders.values()) {
    order.subtotal = order.lines.reduce((sum, line) => sum + line.total, 0);
  }
  return Array.from(orders.values());
}

async function fetchSalesOrdersRaw(input: ListSalesOrdersInput & { salesOrderId?: string | null } = {}) {
  const range = resolveDateRange(input.dateRange ?? "all_time");
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.salesOrderId) {
    params.push(input.salesOrderId);
    conditions.push(`so.id = $${params.length}`);
  }
  if (range) {
    params.push(range.start);
    conditions.push(`so."createdAt" >= $${params.length}`);
    params.push(range.end);
    conditions.push(`so."createdAt" < $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await prisma.$queryRawUnsafe<RawSalesOrderRow[]>(
    `
      SELECT
        so.id AS order_id,
        so.status::text AS order_status,
        so."createdAt" AS order_created_at,
        c.id AS customer_id,
        c.name AS customer_name,
        c."taxId" AS customer_tax_id,
        c.city AS customer_city,
        c.status::text AS customer_status,
        p.id AS product_id,
        p.sku AS product_sku,
        p.name AS product_name,
        sol.quantity AS line_quantity,
        sol."unitPriceCents" AS line_unit_price_cents,
        sol."totalCents" AS line_total_cents
      FROM "SalesOrder" so
      JOIN "Customer" c ON c.id = so."customerId"
      LEFT JOIN "SalesOrderLine" sol ON sol."salesOrderId" = so.id
      LEFT JOIN "Product" p ON p.id = sol."productId"
      ${where}
      ORDER BY so."createdAt" DESC, sol.id ASC
      LIMIT 500
    `,
    ...params
  );
  const customerQuery = normalize(input.customerQuery ?? "");
  return mapRawSalesOrderRows(rows)
    .filter((order) => !input.status || order.status === input.status)
    .filter((order) => !customerQuery || normalize(order.customer.name).includes(customerQuery))
    .slice(0, input.take ?? 25);
}

async function fetchSalesOrderRaw(salesOrderId: string) {
  return (await fetchSalesOrdersRaw({ salesOrderId, take: 1 }))[0] ?? null;
}

async function assertSalesOrderCanChange(salesOrderId: string) {
  const order = await fetchSalesOrderRaw(salesOrderId);
  if (!order) {
    throw new Error(`Sales order ${salesOrderId} not found.`);
  }
  if (order.status === "canceled") {
    throw new Error(`Sales order ${salesOrderId} is canceled and cannot be changed.`);
  }
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
  async createCustomer(input: { name: string }) {
    await ensureSeeded();
    const name = cleanName(input.name);
    const normalizedName = normalize(name);
    const customers = (await prisma.customer.findMany()) as DbCustomer[];
    const existing = customers.find((customer) => normalize(customer.name) === normalizedName);
    if (existing) {
      throw new Error(`Customer "${existing.name}" already exists.`);
    }

    const customer = (await prisma.customer.create({
      data: {
        id: `cus_${slugify(name) || "customer"}_${randomToken()}`,
        name,
        taxId: `DEMO-CUS-${Date.now()}-${randomToken().toUpperCase()}`,
        city: "Nao informada",
        status: "active"
      }
    })) as DbCustomer;

    await audit("create_customer", `Created customer ${customer.name}`, { customerId: customer.id });
    return mapCustomer(customer);
  }

  async listCustomers() {
    await ensureSeeded();
    const customers = (await prisma.customer.findMany({
      orderBy: {
        name: "asc"
      }
    })) as DbCustomer[];
    await audit("list_customers", "Listed customers", { resultCount: customers.length });
    return customers.map(mapCustomer);
  }

  async createProduct(input: { name: string }) {
    await ensureSeeded();
    const name = cleanName(input.name);
    const normalizedName = normalize(name);
    const products = (await prisma.product.findMany()) as DbProduct[];
    const existing = products.find((product) => normalize(product.name) === normalizedName);
    if (existing) {
      throw new Error(`Product "${existing.name}" already exists.`);
    }

    const product = (await prisma.product.create({
      data: {
        id: `prd_${slugify(name) || "product"}_${randomToken()}`,
        sku: `SKU-${slugify(name).replaceAll("_", "-").toUpperCase() || "ITEM"}-${randomToken().toUpperCase()}`,
        name,
        unitPriceCents: 0,
        availableStock: 0
      }
    })) as DbProduct;

    await audit("create_product", `Created product ${product.name}`, { productId: product.id });
    return mapProduct(product);
  }

  async createSupplier(input: { name: string }) {
    await ensureSeeded();
    const name = cleanName(input.name);
    const normalizedName = normalize(name);
    const suppliers = (await prisma.supplier.findMany()) as DbSupplier[];
    const existing = suppliers.find((supplier) => normalize(supplier.name) === normalizedName);
    if (existing) {
      throw new Error(`Supplier "${existing.name}" already exists.`);
    }

    const supplier = (await prisma.supplier.create({
      data: {
        id: `sup_${slugify(name) || "supplier"}_${randomToken()}`,
        name,
        status: "active"
      }
    })) as DbSupplier;

    await audit("create_supplier", `Created supplier ${supplier.name}`, { supplierId: supplier.id });
    return mapSupplier(supplier);
  }

  async updateProduct(input: {
    productId: string;
    unitPrice?: number | null;
    availableStock?: number | null;
  }) {
    await ensureSeeded();
    const product = (await prisma.product.update({
      where: { id: input.productId },
      data: {
        ...(input.unitPrice !== undefined && input.unitPrice !== null
          ? { unitPriceCents: toCents(input.unitPrice) }
          : {}),
        ...(input.availableStock !== undefined && input.availableStock !== null
          ? { availableStock: input.availableStock }
          : {})
      }
    })) as DbProduct;

    await audit("update_product", `Updated product ${product.name}`, {
      productId: product.id,
      unitPrice: input.unitPrice ?? null,
      availableStock: input.availableStock ?? null
    });
    return mapProduct(product);
  }

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

  async listLowStockProducts(input: { threshold?: number } = {}) {
    await ensureSeeded();
    const threshold = input.threshold ?? 10;
    const products = (await prisma.product.findMany({
      where: {
        availableStock: {
          lte: threshold
        }
      },
      orderBy: [
        { availableStock: "asc" },
        { name: "asc" }
      ]
    })) as DbProduct[];
    await audit("list_low_stock_products", `Listed products with stock at or below ${threshold}`, {
      threshold,
      count: products.length
    });
    return products.map(mapProduct);
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

  async addSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }) {
    await ensureSeeded();
    await assertSalesOrderCanChange(input.salesOrderId);
    const order = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const existingOrder = await tx.salesOrder.findUniqueOrThrow({
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
      if (existingOrder.status === "canceled") {
        throw new Error(`Sales order ${input.salesOrderId} is canceled and cannot be changed.`);
      }
      const product = (await tx.product.findUniqueOrThrow({
        where: { id: input.productId }
      })) as DbProduct;
      if (product.availableStock < input.quantity) {
        throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
      }

      const currentLine = existingOrder.lines.find((line) => line.productId === product.id);
      if (currentLine) {
        const nextQuantity = currentLine.quantity + input.quantity;
        await tx.salesOrderLine.update({
          where: { id: currentLine.id },
          data: {
            quantity: nextQuantity,
            unitPriceCents: product.unitPriceCents,
            totalCents: product.unitPriceCents * nextQuantity
          }
        });
      } else {
        await tx.salesOrderLine.create({
          data: {
            salesOrderId: existingOrder.id,
            productId: product.id,
            quantity: input.quantity,
            unitPriceCents: product.unitPriceCents,
            totalCents: product.unitPriceCents * input.quantity
          }
        });
      }

      await tx.product.update({
        where: { id: product.id },
        data: {
          availableStock: {
            decrement: input.quantity
          }
        }
      });

      return tx.salesOrder.findUniqueOrThrow({
        where: { id: existingOrder.id },
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

    await audit("add_sales_order_line", `Added item to sales order ${order.id}`, {
      salesOrderId: order.id,
      productId: input.productId,
      quantity: input.quantity
    });
    return mapSalesOrder(order);
  }

  async setSalesOrderLineQuantity(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }) {
    await ensureSeeded();
    await assertSalesOrderCanChange(input.salesOrderId);
    const order = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const existingOrder = await tx.salesOrder.findUniqueOrThrow({
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
      if (existingOrder.status === "canceled") {
        throw new Error(`Sales order ${input.salesOrderId} is canceled and cannot be changed.`);
      }
      const currentLine = existingOrder.lines.find((line) => line.productId === input.productId);
      if (!currentLine) {
        throw new Error(`Product ${input.productId} is not in sales order ${input.salesOrderId}.`);
      }
      if (input.quantity === 0 && existingOrder.lines.length === 1) {
        throw new Error(`Sales order ${input.salesOrderId} must keep at least one item.`);
      }

      const delta = input.quantity - currentLine.quantity;
      if (delta > 0) {
        const product = (await tx.product.findUniqueOrThrow({
          where: { id: input.productId }
        })) as DbProduct;
        if (product.availableStock < delta) {
          throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
        }
        await tx.product.update({
          where: { id: product.id },
          data: {
            availableStock: {
              decrement: delta
            }
          }
        });
      } else if (delta < 0) {
        await tx.product.update({
          where: { id: input.productId },
          data: {
            availableStock: {
              increment: Math.abs(delta)
            }
          }
        });
      }

      if (input.quantity === 0) {
        await tx.salesOrderLine.delete({
          where: { id: currentLine.id }
        });
      } else {
        await tx.salesOrderLine.update({
          where: { id: currentLine.id },
          data: {
            quantity: input.quantity,
            totalCents: currentLine.unitPriceCents * input.quantity
          }
        });
      }

      return tx.salesOrder.findUniqueOrThrow({
        where: { id: existingOrder.id },
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

    await audit("set_sales_order_line_quantity", `Set item quantity in sales order ${order.id}`, {
      salesOrderId: order.id,
      productId: input.productId,
      quantity: input.quantity
    });
    return mapSalesOrder(order);
  }

  async removeSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
  }) {
    await ensureSeeded();
    await assertSalesOrderCanChange(input.salesOrderId);
    const order = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const existingOrder = await tx.salesOrder.findUniqueOrThrow({
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
      if (existingOrder.status === "canceled") {
        throw new Error(`Sales order ${input.salesOrderId} is canceled and cannot be changed.`);
      }
      const currentLine = existingOrder.lines.find((line) => line.productId === input.productId);
      if (!currentLine) {
        throw new Error(`Product ${input.productId} is not in sales order ${input.salesOrderId}.`);
      }
      if (existingOrder.lines.length === 1) {
        throw new Error(`Sales order ${input.salesOrderId} must keep at least one item.`);
      }

      await tx.salesOrderLine.delete({
        where: { id: currentLine.id }
      });
      await tx.product.update({
        where: { id: input.productId },
        data: {
          availableStock: {
            increment: currentLine.quantity
          }
        }
      });

      return tx.salesOrder.findUniqueOrThrow({
        where: { id: existingOrder.id },
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

    await audit("remove_sales_order_line", `Removed item from sales order ${order.id}`, {
      salesOrderId: order.id,
      productId: input.productId
    });
    return mapSalesOrder(order);
  }

  async cancelSalesOrder(input: { salesOrderId: string }) {
    await ensureSeeded();
    const currentOrder = await fetchSalesOrderRaw(input.salesOrderId);
    if (!currentOrder) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    if (currentOrder.status === "canceled") {
      await audit("cancel_sales_order", `Sales order ${currentOrder.id} was already canceled`, {
        salesOrderId: currentOrder.id
      });
      return currentOrder;
    }

    const salesOrderId = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const existingOrder = await tx.salesOrder.findUniqueOrThrow({
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

      if (existingOrder.status !== "canceled") {
        for (const line of existingOrder.lines) {
          await tx.product.update({
            where: { id: line.productId },
            data: {
              availableStock: {
                increment: line.quantity
              }
            }
          });
        }

        await tx.$executeRawUnsafe(
          'UPDATE "SalesOrder" SET status = $1::"SalesOrderStatus" WHERE id = $2',
          "canceled",
          existingOrder.id
        );
      }

      return existingOrder.id;
    });

    const order = await fetchSalesOrderRaw(salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${salesOrderId} not found after cancellation.`);
    }
    await audit("cancel_sales_order", `Canceled sales order ${order.id}`, {
      salesOrderId: order.id
    });
    return order;
  }

  async duplicateSalesOrder(input: { salesOrderId: string }) {
    await ensureSeeded();
    await assertSalesOrderCanChange(input.salesOrderId);
    const order = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const sourceOrder = await tx.salesOrder.findUniqueOrThrow({
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

      if (sourceOrder.lines.length === 0) {
        throw new Error(`Sales order ${input.salesOrderId} has no items to duplicate.`);
      }

      for (const line of sourceOrder.lines) {
        if (line.product.availableStock < line.quantity) {
          throw new Error(`${line.product.sku} has only ${line.product.availableStock} units available.`);
        }
      }

      const id = await nextBusinessId(tx, "sales_order", "SO", 1001);
      const duplicatedOrder = await tx.salesOrder.create({
        data: {
          id,
          customerId: sourceOrder.customerId,
          status: "confirmed",
          lines: {
            create: sourceOrder.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPriceCents: line.unitPriceCents,
              totalCents: line.unitPriceCents * line.quantity
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

      for (const line of sourceOrder.lines) {
        await tx.product.update({
          where: { id: line.productId },
          data: {
            availableStock: {
              decrement: line.quantity
            }
          }
        });
      }

      return duplicatedOrder;
    });

    await audit("duplicate_sales_order", `Duplicated sales order ${input.salesOrderId} as ${order.id}`, {
      sourceSalesOrderId: input.salesOrderId,
      salesOrderId: order.id
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
    const order = await fetchSalesOrderRaw(input.salesOrderId);
    await audit("get_sales_order", `Fetched sales order ${input.salesOrderId}`);
    return order;
  }

  async listSalesOrders(input: ListSalesOrdersInput = {}) {
    await ensureSeeded();
    const orders = await fetchSalesOrdersRaw(input);
    const take = input.take ?? 25;
    await audit("list_sales_orders", "Listed sales orders", {
      customerQuery: input.customerQuery ?? null,
      dateRange: input.dateRange ?? "all_time",
      status: input.status ?? null,
      resultCount: orders.length
    });
    return orders.slice(0, take);
  }

  async listRecentOrders() {
    return this.listSalesOrders({ take: 10 });
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
    productQueries?: string[] | null;
    customerQuery?: string | null;
    dateRange: "today" | "last_7_days" | "month_to_date" | "all_time";
    groupBy?: "product" | "customer" | "day" | null;
  }) {
    await ensureSeeded();
    const productQueries = normalizeProductQueries(input.productQuery, input.productQueries);
    const customerQuery = normalize(input.customerQuery ?? "");
    const orders = await fetchSalesOrdersRaw({
      dateRange: input.dateRange,
      status: "confirmed",
      take: 100
    });

    const filteredOrders = orders.filter((order) => {
      const matchesCustomer = customerQuery ? normalize(order.customer.name).includes(customerQuery) : true;
      const matchesProduct = productQueries.length
        ? order.lines.some(
            (line) =>
              productQueries.some((productQuery) =>
                normalize(line.name).includes(productQuery) ||
                normalize(line.sku).includes(productQuery)
              )
          )
        : true;
      return matchesCustomer && matchesProduct;
    });

    const filteredLines = filteredOrders.flatMap((order) =>
      order.lines.filter((line) =>
        productQueries.length
          ? productQueries.some((productQuery) =>
              normalize(line.name).includes(productQuery) ||
              normalize(line.sku).includes(productQuery)
            )
          : true
      )
    );

    const value =
      input.metric === "units_sold"
        ? filteredLines.reduce((sum, line) => sum + line.quantity, 0)
        : input.metric === "revenue"
          ? filteredLines.reduce((sum, line) => sum + line.total, 0)
          : filteredOrders.length;

    const rows = buildMetricRows(
      input.groupBy,
      input.metric,
      filteredOrders.map((order) => ({
        createdAt: new Date(order.createdAt),
        customer: { name: order.customer.name },
        lines: order.lines.map((line) => ({
          quantity: line.quantity,
          totalCents: toCents(line.total),
          product: { name: line.name, sku: line.sku }
        }))
      })),
      productQueries
    );
    await audit("query_sales_metrics", `Queried ${input.metric} for ${input.dateRange}`, {
      metric: input.metric,
      productQuery: input.productQuery ?? null,
      productQueries: input.productQueries ?? null,
      customerQuery: input.customerQuery ?? null,
      dateRange: input.dateRange,
      value
    });

    return {
      metric: input.metric,
      value,
      label: buildMetricLabel(input.metric, input.productQuery ?? input.productQueries?.join(", "), input.dateRange),
      query: buildAnalyticsQuery({
        ...input,
        productQueries,
        dataSource: "postgres"
      }),
      rows
    } satisfies AnalyticsResult;
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

function buildAnalyticsQuery(input: {
  productQuery?: string | null;
  productQueries?: string[] | null;
  customerQuery?: string | null;
  dateRange: "today" | "last_7_days" | "month_to_date" | "all_time";
  groupBy?: "product" | "customer" | "day" | null;
  dataSource: "postgres";
}) {
  const entities: AnalyticsResult["query"]["entities"] = ["sales_orders", "sales_order_lines", "customers", "products"];

  return {
    capability: "query_sales_metrics" as const,
    entities,
    filters: [
      { label: "period", value: input.dateRange.replaceAll("_", " ") },
      input.productQuery ? { label: "product", value: input.productQuery } : null,
      input.productQueries?.length ? { label: "products", value: input.productQueries.join(", ") } : null,
      input.customerQuery ? { label: "customer", value: input.customerQuery } : null
    ].filter((filter): filter is { label: string; value: string } => Boolean(filter)),
    groupBy: input.groupBy ?? null,
    dateRange: input.dateRange,
    dataSource: input.dataSource
  };
}

function normalizeProductQueries(productQuery?: string | null, productQueries?: string[] | null) {
  const queries = (productQueries?.length ? productQueries : [productQuery])
    .map((query) => normalize(query ?? ""))
    .filter(Boolean);
  return Array.from(new Set(queries));
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
      product: { name: string; sku: string };
    }>;
  }>,
  productQueries: string[]
) {
  if (!groupBy) {
    return [];
  }

  const rows = new Map<string, number>();
  for (const order of orders) {
    const matchingLines = productQueries.length
      ? order.lines.filter(
          (line) =>
            productQueries.some((productQuery) =>
              normalize(line.product.name).includes(productQuery) ||
              normalize(line.product.sku).includes(productQuery)
            )
        )
      : order.lines;
    const labels =
      groupBy === "customer"
        ? [{ label: order.customer.name, lines: matchingLines }]
        : groupBy === "day"
          ? [{ label: order.createdAt.toISOString().slice(0, 10), lines: matchingLines }]
          : matchingLines.map((line) => ({ label: line.product.name, lines: [line] }));

    for (const item of labels) {
      if (item.lines.length === 0) {
        continue;
      }
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
