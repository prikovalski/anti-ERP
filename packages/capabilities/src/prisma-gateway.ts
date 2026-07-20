import {
  AnalyticsResult,
  ConceptInvoice,
  Customer,
  IntelligentReport,
  InventoryMovement,
  ListConceptInvoicesInput,
  ListInventoryMovementsInput,
  ListSalesOrdersInput,
  ManagerialReport,
  ManagerialReportKind,
  Product,
  QueryManagerialReportInput,
  SalesOrder,
  SalesOrderLine,
  SalesOrderPreview,
  SearchCatalogInput,
  Supplier,
  cleanName,
  demoCustomers,
  demoProducts,
  normalizeText,
  roundMoney,
  slugify
} from "@anti-erp/shared";
import { Prisma, PrismaClient } from "@prisma/client";
import { queryIntelligentReportFromSql } from "./intelligent-report";
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
  reservedStock?: number;
  status?: "active" | "inactive";
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

type RawConceptInvoiceRow = {
  invoice_id: string;
  sales_order_id: string;
  customer_name: string;
  amount_cents: number;
  issued_at: Date;
  disclaimer: string;
  status: "issued" | "canceled" | "reissued";
  canceled_at: Date | null;
  reissued_from_invoice_id: string | null;
  replaced_by_invoice_id: string | null;
  source_order_updated_at: Date | null;
  source_order_amount_cents: number;
  current_order_amount_cents: number;
};

type RawInventoryMovementRow = {
  id: string;
  product_id: string;
  sku: string;
  product_name: string;
  sales_order_id: string | null;
  type: InventoryMovement["type"];
  quantity: number;
  previous_available_stock: number;
  next_available_stock: number;
  previous_reserved_stock: number;
  next_reserved_stock: number;
  reason: string | null;
  created_at: Date;
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
let invoiceSchemaPromise: Promise<void> | null = null;
let productSchemaPromise: Promise<void> | null = null;
let inventorySchemaPromise: Promise<void> | null = null;

function ensureSeeded() {
  seedPromise ??= seedDemoData();
  return seedPromise;
}

function ensureInvoiceSchema() {
  invoiceSchemaPromise ??= ensureConceptInvoiceColumns();
  return invoiceSchemaPromise;
}

function ensureProductSchema() {
  productSchemaPromise ??= Promise.all([
    prisma.$executeRawUnsafe('ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT \'active\''),
    prisma.$executeRawUnsafe('ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "reservedStock" INTEGER NOT NULL DEFAULT 0')
  ]).then(() => undefined);
  return productSchemaPromise;
}

function ensureInventorySchema() {
  inventorySchemaPromise ??= ensureInventoryTables();
  return inventorySchemaPromise;
}

const normalize = normalizeText;

function randomToken() {
  return Math.random().toString(36).slice(2, 8);
}

function toDbCatalogStatus(status: "active" | "inactive" | "blocked" | null | undefined): "active" | "blocked" | undefined {
  if (!status) {
    return undefined;
  }
  return status === "active" ? "active" : "blocked";
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
  reservedStock?: number | null;
  status?: "active" | "inactive" | string | null;
}): Product {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    unitPrice: fromCents(product.unitPriceCents),
    availableStock: product.availableStock,
    reservedStock: product.reservedStock ?? 0,
    status: product.status === "inactive" ? "inactive" : "active"
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
  const range = resolveExplicitDateRange(input.dateFrom, input.dateTo) ?? resolveDateRange(input.dateRange ?? "all_time");
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

async function ensureConceptInvoiceColumns() {
  await prisma.$executeRawUnsafe('ALTER TABLE "ConceptInvoice" ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT \'issued\'');
  await prisma.$executeRawUnsafe('ALTER TABLE "ConceptInvoice" ADD COLUMN IF NOT EXISTS "canceledAt" TIMESTAMP(3)');
  await prisma.$executeRawUnsafe('ALTER TABLE "ConceptInvoice" ADD COLUMN IF NOT EXISTS "reissuedFromInvoiceId" TEXT');
  await prisma.$executeRawUnsafe('ALTER TABLE "ConceptInvoice" ADD COLUMN IF NOT EXISTS "replacedByInvoiceId" TEXT');
  await prisma.$executeRawUnsafe('ALTER TABLE "ConceptInvoice" ADD COLUMN IF NOT EXISTS "sourceOrderUpdatedAt" TIMESTAMP(3)');
  await prisma.$executeRawUnsafe('ALTER TABLE "ConceptInvoice" ADD COLUMN IF NOT EXISTS "sourceOrderAmountCents" INTEGER NOT NULL DEFAULT 0');
  await prisma.$executeRawUnsafe(`
    UPDATE "ConceptInvoice" ci
    SET "sourceOrderAmountCents" = ci."amountCents"
    WHERE ci."sourceOrderAmountCents" = 0
  `);
}

async function ensureInventoryTables() {
  await ensureProductSchema();
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "InventoryMovement" (
      id TEXT PRIMARY KEY,
      "productId" TEXT NOT NULL REFERENCES "Product"(id),
      "salesOrderId" TEXT,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      "previousAvailableStock" INTEGER NOT NULL,
      "nextAvailableStock" INTEGER NOT NULL,
      "previousReservedStock" INTEGER NOT NULL,
      "nextReservedStock" INTEGER NOT NULL,
      reason TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
    )
  `);
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "InventoryMovement_productId_idx" ON "InventoryMovement" ("productId")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "InventoryMovement_salesOrderId_idx" ON "InventoryMovement" ("salesOrderId")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "InventoryMovement_createdAt_idx" ON "InventoryMovement" ("createdAt")');
}

function mapRawInventoryMovement(row: RawInventoryMovementRow): InventoryMovement {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    productName: row.product_name,
    salesOrderId: row.sales_order_id,
    type: row.type,
    quantity: row.quantity,
    previousAvailableStock: row.previous_available_stock,
    nextAvailableStock: row.next_available_stock,
    previousReservedStock: row.previous_reserved_stock,
    nextReservedStock: row.next_reserved_stock,
    reason: row.reason,
    createdAt: row.created_at.toISOString()
  };
}

async function fetchInventoryMovementsRaw(input: ListInventoryMovementsInput = {}) {
  await ensureInventorySchema();
  const range = resolveDateRange(input.dateRange ?? "all_time");
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.productId) {
    params.push(input.productId);
    conditions.push(`im."productId" = $${params.length}`);
  }
  if (input.salesOrderId) {
    params.push(input.salesOrderId);
    conditions.push(`im."salesOrderId" = $${params.length}`);
  }
  if (input.type) {
    params.push(input.type);
    conditions.push(`im.type = $${params.length}`);
  }
  if (range) {
    params.push(range.start);
    conditions.push(`im."createdAt" >= $${params.length}`);
    params.push(range.end);
    conditions.push(`im."createdAt" < $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await prisma.$queryRawUnsafe<RawInventoryMovementRow[]>(
    `
      SELECT
        im.id,
        im."productId" AS product_id,
        p.sku,
        p.name AS product_name,
        im."salesOrderId" AS sales_order_id,
        im.type,
        im.quantity,
        im."previousAvailableStock" AS previous_available_stock,
        im."nextAvailableStock" AS next_available_stock,
        im."previousReservedStock" AS previous_reserved_stock,
        im."nextReservedStock" AS next_reserved_stock,
        im.reason,
        im."createdAt" AS created_at
      FROM "InventoryMovement" im
      JOIN "Product" p ON p.id = im."productId"
      ${where}
      ORDER BY im."createdAt" DESC
      LIMIT 500
    `,
    ...params
  );
  return rows.map(mapRawInventoryMovement).slice(0, input.take ?? 25);
}

async function applyInventoryMovement(input: {
  productId: string;
  salesOrderId?: string | null;
  type: InventoryMovement["type"];
  quantity: number;
  nextAvailableStock: (current: DbProduct & { reservedStock: number }) => number;
  nextReservedStock: (current: DbProduct & { reservedStock: number }) => number;
  reason?: string | null;
}) {
  await ensureSeeded();
  await ensureInventorySchema();
  return applyInventoryMovementWithClient(prisma, input);
}

async function applyInventoryMovementWithClient(tx: PrismaTransaction, input: {
  productId: string;
  salesOrderId?: string | null;
  type: InventoryMovement["type"];
  quantity: number;
  nextAvailableStock: (current: DbProduct & { reservedStock: number }) => number;
  nextReservedStock: (current: DbProduct & { reservedStock: number }) => number;
  reason?: string | null;
}) {
  const movementId = `im_${randomToken()}_${Date.now()}`;
  const createMovement = async (client: PrismaTransaction) => {
    const rows = await client.$queryRawUnsafe<Array<DbProduct & { reservedStock: number }>>(
      'SELECT id, sku, name, "unitPriceCents", "availableStock", "reservedStock", status FROM "Product" WHERE id = $1 FOR UPDATE',
      input.productId
    );
    const product = rows[0];
    if (!product) {
      throw new Error(`Product ${input.productId} not found.`);
    }
    const previousAvailableStock = product.availableStock;
    const previousReservedStock = product.reservedStock ?? 0;
    const nextAvailableStock = input.nextAvailableStock(product);
    const nextReservedStock = input.nextReservedStock(product);
    if (nextAvailableStock < 0 || nextReservedStock < 0) {
      throw new Error(`Insufficient stock for ${product.sku}.`);
    }
    await client.$executeRawUnsafe(
      'UPDATE "Product" SET "availableStock" = $2, "reservedStock" = $3 WHERE id = $1',
      input.productId,
      nextAvailableStock,
      nextReservedStock
    );
    await client.$executeRawUnsafe(
      `
        INSERT INTO "InventoryMovement" (
          id,
          "productId",
          "salesOrderId",
          type,
          quantity,
          "previousAvailableStock",
          "nextAvailableStock",
          "previousReservedStock",
          "nextReservedStock",
          reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      movementId,
      input.productId,
      input.salesOrderId ?? null,
      input.type,
      input.quantity,
      previousAvailableStock,
      nextAvailableStock,
      previousReservedStock,
      nextReservedStock,
      input.reason ?? null
    );
  };

  if (tx === prisma) {
    await prisma.$transaction(async (transaction: PrismaTransaction) => {
      await createMovement(transaction);
    });
  } else {
    await createMovement(tx);
    return null as unknown as InventoryMovement;
  }
  const [movement] = await fetchInventoryMovementsRaw({ take: 1 });
  if (!movement || movement.id !== movementId) {
    const [created] = await prisma.$queryRawUnsafe<RawInventoryMovementRow[]>(
      `
        SELECT
          im.id,
          im."productId" AS product_id,
          p.sku,
          p.name AS product_name,
          im."salesOrderId" AS sales_order_id,
          im.type,
          im.quantity,
          im."previousAvailableStock" AS previous_available_stock,
          im."nextAvailableStock" AS next_available_stock,
          im."previousReservedStock" AS previous_reserved_stock,
          im."nextReservedStock" AS next_reserved_stock,
          im.reason,
          im."createdAt" AS created_at
        FROM "InventoryMovement" im
        JOIN "Product" p ON p.id = im."productId"
        WHERE im.id = $1
      `,
      movementId
    );
    if (!created) {
      throw new Error(`Inventory movement ${movementId} not found after creation.`);
    }
    return mapRawInventoryMovement(created);
  }
  return movement;
}

function mapRawConceptInvoice(row: RawConceptInvoiceRow): ConceptInvoice {
  return {
    id: row.invoice_id,
    salesOrderId: row.sales_order_id,
    customerName: row.customer_name,
    amount: fromCents(row.amount_cents),
    issuedAt: row.issued_at.toISOString(),
    disclaimer: row.disclaimer,
    status: row.status,
    canceledAt: row.canceled_at?.toISOString() ?? null,
    reissuedFromInvoiceId: row.reissued_from_invoice_id,
    replacedByInvoiceId: row.replaced_by_invoice_id,
    sourceOrderUpdatedAt: row.source_order_updated_at?.toISOString() ?? null,
    orderChangedAfterIssue: row.source_order_amount_cents !== row.current_order_amount_cents
  };
}

async function fetchConceptInvoicesRaw(input: ListConceptInvoicesInput & { invoiceId?: string | null } = {}) {
  await ensureInvoiceSchema();
  const range = resolveDateRange(input.dateRange ?? "all_time");
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.invoiceId) {
    params.push(input.invoiceId);
    conditions.push(`ci.id = $${params.length}`);
  }
  if (input.salesOrderId) {
    params.push(input.salesOrderId);
    conditions.push(`ci."salesOrderId" = $${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    conditions.push(`ci.status = $${params.length}`);
  }
  if (range) {
    params.push(range.start);
    conditions.push(`ci."issuedAt" >= $${params.length}`);
    params.push(range.end);
    conditions.push(`ci."issuedAt" < $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await prisma.$queryRawUnsafe<RawConceptInvoiceRow[]>(
    `
      SELECT
        ci.id AS invoice_id,
        ci."salesOrderId" AS sales_order_id,
        c.name AS customer_name,
        ci."amountCents" AS amount_cents,
        ci."issuedAt" AS issued_at,
        ci.disclaimer,
        ci.status,
        ci."canceledAt" AS canceled_at,
        ci."reissuedFromInvoiceId" AS reissued_from_invoice_id,
        ci."replacedByInvoiceId" AS replaced_by_invoice_id,
        ci."sourceOrderUpdatedAt" AS source_order_updated_at,
        ci."sourceOrderAmountCents" AS source_order_amount_cents,
        COALESCE(SUM(sol."totalCents"), 0)::int AS current_order_amount_cents
      FROM "ConceptInvoice" ci
      JOIN "SalesOrder" so ON so.id = ci."salesOrderId"
      JOIN "Customer" c ON c.id = so."customerId"
      LEFT JOIN "SalesOrderLine" sol ON sol."salesOrderId" = so.id
      ${where}
      GROUP BY ci.id, c.name
      ORDER BY ci."issuedAt" DESC
      LIMIT 500
    `,
    ...params
  );
  return rows.map(mapRawConceptInvoice).slice(0, input.take ?? 25);
}

async function fetchConceptInvoiceRaw(invoiceId: string) {
  return (await fetchConceptInvoicesRaw({ invoiceId, take: 1 }))[0] ?? null;
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

function filterByCatalogSearch<T extends { name: string; status?: string; sku?: string; taxId?: string }>(
  records: T[],
  input: SearchCatalogInput = {}
) {
  const query = normalize(input.query ?? "");
  const dbStatus = toDbCatalogStatus(input.status);
  const productStatus = input.status === "inactive" ? "inactive" : input.status === "active" ? "active" : undefined;
  return records
    .filter((record) => {
      if (dbStatus && (record.status === "blocked" || record.status === "active") && record.status !== dbStatus) {
        return false;
      }
      if (productStatus && record.status !== undefined && record.status !== "blocked" && record.status !== productStatus) {
        return false;
      }
      if (!query) {
        return true;
      }
      return normalize(record.name).includes(query)
        || Boolean(record.sku && normalize(record.sku).includes(query))
        || Boolean(record.taxId && normalize(record.taxId).includes(query));
    })
    .slice(0, input.take ?? 25);
}

function assertUniqueName<T extends { id: string; name: string }>(
  records: T[],
  nextName: string,
  currentId: string | null,
  label: string
) {
  const normalizedName = normalize(nextName);
  const existing = records.find((record) => record.id !== currentId && normalize(record.name) === normalizedName);
  if (existing) {
    throw new Error(`${label} "${existing.name}" already exists.`);
  }
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

  async updateCustomer(input: {
    customerId: string;
    name?: string | null;
    city?: string | null;
    status?: "active" | "inactive" | "blocked" | null;
  }) {
    await ensureSeeded();
    const customers = (await prisma.customer.findMany()) as DbCustomer[];
    const current = customers.find((customer) => customer.id === input.customerId);
    if (!current) {
      throw new Error(`Customer ${input.customerId} not found.`);
    }
    const nextName = input.name ? cleanName(input.name) : current.name;
    assertUniqueName(customers, nextName, current.id, "Customer");
    const customer = (await prisma.customer.update({
      where: { id: input.customerId },
      data: {
        ...(input.name !== undefined && input.name !== null ? { name: nextName } : {}),
        ...(input.city !== undefined && input.city !== null ? { city: cleanName(input.city) } : {}),
        ...(input.status ? { status: toDbCatalogStatus(input.status) } : {})
      }
    })) as DbCustomer;
    await audit("update_customer", `Updated customer ${customer.name}`, { customerId: customer.id });
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

  async searchCustomersAdvanced(input: SearchCatalogInput = {}) {
    await ensureSeeded();
    const customers = (await prisma.customer.findMany({
      orderBy: { name: "asc" }
    })) as DbCustomer[];
    const matches = filterByCatalogSearch(customers, input);
    await audit("search_customers_advanced", "Advanced customer search", { resultCount: matches.length });
    return matches.map(mapCustomer);
  }

  async createProduct(input: { name: string }) {
    await ensureSeeded();
    await ensureProductSchema();
    const name = cleanName(input.name);
    const products = (await prisma.product.findMany()) as DbProduct[];
    assertUniqueName(products, name, null, "Product");

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

  async listProducts(input: SearchCatalogInput = {}) {
    await ensureSeeded();
    await ensureProductSchema();
    const products = await prisma.$queryRawUnsafe<DbProduct[]>('SELECT id, sku, name, "unitPriceCents", "availableStock", "reservedStock", status FROM "Product" ORDER BY name ASC');
    const matches = filterByCatalogSearch(products, input);
    await audit("list_products", "Listed products", { resultCount: matches.length });
    return matches.map(mapProduct);
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

  async updateSupplier(input: {
    supplierId: string;
    name?: string | null;
    status?: "active" | "inactive" | "blocked" | null;
  }) {
    await ensureSeeded();
    const suppliers = (await prisma.supplier.findMany()) as DbSupplier[];
    const current = suppliers.find((supplier) => supplier.id === input.supplierId);
    if (!current) {
      throw new Error(`Supplier ${input.supplierId} not found.`);
    }
    const nextName = input.name ? cleanName(input.name) : current.name;
    assertUniqueName(suppliers, nextName, current.id, "Supplier");
    const supplier = (await prisma.supplier.update({
      where: { id: input.supplierId },
      data: {
        ...(input.name !== undefined && input.name !== null ? { name: nextName } : {}),
        ...(input.status ? { status: toDbCatalogStatus(input.status) } : {})
      }
    })) as DbSupplier;
    await audit("update_supplier", `Updated supplier ${supplier.name}`, { supplierId: supplier.id });
    return mapSupplier(supplier);
  }

  async searchSupplier(input: { query: string }) {
    return this.listSuppliers({ query: input.query });
  }

  async listSuppliers(input: SearchCatalogInput = {}) {
    await ensureSeeded();
    const suppliers = (await prisma.supplier.findMany({
      orderBy: { name: "asc" }
    })) as DbSupplier[];
    const matches = filterByCatalogSearch(suppliers, input);
    await audit("list_suppliers", "Listed suppliers", { resultCount: matches.length });
    return matches.map(mapSupplier);
  }

  async updateProduct(input: {
    productId: string;
    name?: string | null;
    unitPrice?: number | null;
    availableStock?: number | null;
    status?: "active" | "inactive" | null;
  }) {
    await ensureSeeded();
    await ensureProductSchema();
    const products = await prisma.$queryRawUnsafe<DbProduct[]>('SELECT id, sku, name, "unitPriceCents", "availableStock", "reservedStock", status FROM "Product"');
    const current = products.find((product) => product.id === input.productId);
    if (!current) {
      throw new Error(`Product ${input.productId} not found.`);
    }
    const nextName = input.name ? cleanName(input.name) : current.name;
    assertUniqueName(products, nextName, current.id, "Product");
    await prisma.$executeRawUnsafe(
      `
        UPDATE "Product"
        SET
          name = $2,
          "unitPriceCents" = $3,
          "availableStock" = $4,
          status = $5
        WHERE id = $1
      `,
      input.productId,
      nextName,
      input.unitPrice !== undefined && input.unitPrice !== null ? toCents(input.unitPrice) : current.unitPriceCents,
      input.availableStock !== undefined && input.availableStock !== null ? input.availableStock : current.availableStock,
      input.status ?? current.status ?? "active"
    );
    const product = (await prisma.$queryRawUnsafe<DbProduct[]>(
      'SELECT id, sku, name, "unitPriceCents", "availableStock", "reservedStock", status FROM "Product" WHERE id = $1',
      input.productId
    ))[0];
    if (!product) {
      throw new Error(`Product ${input.productId} not found after update.`);
    }

    await audit("update_product", `Updated product ${product.name}`, {
      productId: product.id,
      name: input.name ?? null,
      unitPrice: input.unitPrice ?? null,
      availableStock: input.availableStock ?? null,
      status: input.status ?? null
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
    const matches = await this.searchProductsAdvanced({ query: input.query });
    await audit("search_product", `Searched product "${input.query}"`, { resultCount: matches.length });
    return matches;
  }

  async searchProductsAdvanced(input: SearchCatalogInput = {}) {
    return this.listProducts(input);
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
    await ensureProductSchema();
    const threshold = input.threshold ?? 10;
    const products = await prisma.$queryRawUnsafe<DbProduct[]>(
      'SELECT id, sku, name, "unitPriceCents", "availableStock", "reservedStock", status FROM "Product" WHERE "availableStock" <= $1 ORDER BY "availableStock" ASC, name ASC',
      threshold
    );
    await audit("list_low_stock_products", `Listed products with stock at or below ${threshold}`, {
      threshold,
      count: products.length
    });
    return products.map(mapProduct);
  }

  async createInventoryEntry(input: { productId: string; quantity: number; reason?: string | null }) {
    const movement = await applyInventoryMovement({
      productId: input.productId,
      type: "entry",
      quantity: input.quantity,
      reason: input.reason ?? "Entrada de estoque",
      nextAvailableStock: (product) => product.availableStock + input.quantity,
      nextReservedStock: (product) => product.reservedStock ?? 0
    });
    await audit("inventory_entry", `Stock entry for ${movement.sku}`, { productId: input.productId, quantity: input.quantity });
    return movement;
  }

  async createInventoryExit(input: { productId: string; quantity: number; reason?: string | null }) {
    const movement = await applyInventoryMovement({
      productId: input.productId,
      type: "exit",
      quantity: input.quantity,
      reason: input.reason ?? "Saida de estoque",
      nextAvailableStock: (product) => product.availableStock - input.quantity,
      nextReservedStock: (product) => product.reservedStock ?? 0
    });
    await audit("inventory_exit", `Stock exit for ${movement.sku}`, { productId: input.productId, quantity: input.quantity });
    return movement;
  }

  async adjustInventory(input: { productId: string; quantity: number; reason?: string | null }) {
    const movement = await applyInventoryMovement({
      productId: input.productId,
      type: "adjustment",
      quantity: input.quantity,
      reason: input.reason ?? "Ajuste manual de estoque",
      nextAvailableStock: () => input.quantity,
      nextReservedStock: (product) => product.reservedStock ?? 0
    });
    await audit("inventory_adjustment", `Manual stock adjustment for ${movement.sku}`, {
      productId: input.productId,
      quantity: input.quantity
    });
    return movement;
  }

  async reserveInventory(input: {
    productId: string;
    quantity: number;
    salesOrderId?: string | null;
    reason?: string | null;
  }) {
    const movement = await applyInventoryMovement({
      productId: input.productId,
      salesOrderId: input.salesOrderId ?? null,
      type: "reservation",
      quantity: input.quantity,
      reason: input.reason ?? "Reserva de estoque",
      nextAvailableStock: (product) => product.availableStock - input.quantity,
      nextReservedStock: (product) => (product.reservedStock ?? 0) + input.quantity
    });
    await audit("inventory_reservation", `Reserved stock for ${movement.sku}`, {
      productId: input.productId,
      salesOrderId: input.salesOrderId ?? null,
      quantity: input.quantity
    });
    return movement;
  }

  async releaseInventoryReservation(input: {
    productId: string;
    quantity: number;
    salesOrderId?: string | null;
    reason?: string | null;
  }) {
    const movement = await applyInventoryMovement({
      productId: input.productId,
      salesOrderId: input.salesOrderId ?? null,
      type: "reservation_release",
      quantity: input.quantity,
      reason: input.reason ?? "Liberacao de reserva",
      nextAvailableStock: (product) => product.availableStock + input.quantity,
      nextReservedStock: (product) => (product.reservedStock ?? 0) - input.quantity
    });
    await audit("inventory_reservation_release", `Released stock reservation for ${movement.sku}`, {
      productId: input.productId,
      salesOrderId: input.salesOrderId ?? null,
      quantity: input.quantity
    });
    return movement;
  }

  async writeOffInventoryForSalesOrder(input: { salesOrderId: string; reason?: string | null }) {
    await ensureSeeded();
    await ensureInventorySchema();
    const order = await this.getSalesOrder({ salesOrderId: input.salesOrderId });
    if (!order) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    const movements: InventoryMovement[] = [];
    for (const line of order.lines) {
      const productRows = await prisma.$queryRawUnsafe<Array<DbProduct & { reservedStock: number }>>(
        'SELECT id, sku, name, "unitPriceCents", "availableStock", "reservedStock", status FROM "Product" WHERE id = $1',
        line.productId
      );
      const product = productRows[0];
      const reserved = product?.reservedStock ?? 0;
      const reservedToConsume = Math.min(reserved, line.quantity);
      if (reservedToConsume > 0) {
        movements.push(await applyInventoryMovement({
          productId: line.productId,
          salesOrderId: order.id,
          type: "order_writeoff",
          quantity: reservedToConsume,
          reason: input.reason ?? `Baixa por pedido ${order.id}`,
          nextAvailableStock: (current) => current.availableStock,
          nextReservedStock: (current) => (current.reservedStock ?? 0) - reservedToConsume
        }));
      }
      const remaining = line.quantity - reservedToConsume;
      if (remaining > 0) {
        movements.push(await applyInventoryMovement({
          productId: line.productId,
          salesOrderId: order.id,
          type: "order_writeoff",
          quantity: remaining,
          reason: input.reason ?? `Baixa por pedido ${order.id}`,
          nextAvailableStock: (current) => current.availableStock - remaining,
          nextReservedStock: (current) => current.reservedStock ?? 0
        }));
      }
    }
    await audit("inventory_order_writeoff", `Wrote off stock for sales order ${order.id}`, {
      salesOrderId: order.id,
      movementCount: movements.length
    });
    return movements;
  }

  async listInventoryMovements(input: ListInventoryMovementsInput = {}) {
    const movements = await fetchInventoryMovementsRaw(input);
    await audit("list_inventory_movements", "Listed inventory movements", {
      productId: input.productId ?? null,
      salesOrderId: input.salesOrderId ?? null,
      type: input.type ?? null,
      resultCount: movements.length
    });
    return movements;
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
    await ensureInventorySchema();
    const order = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const id = await nextBusinessId(tx, "sales_order", "SO", 1001);
      const createdOrder = await tx.salesOrder.create({
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
      for (const line of input.preview.lines) {
        await applyInventoryMovementWithClient(tx, {
          productId: line.productId,
          salesOrderId: id,
          type: "reservation",
          quantity: line.quantity,
          reason: `Reserva automatica do pedido ${id}`,
          nextAvailableStock: (product) => product.availableStock - line.quantity,
          nextReservedStock: (product) => (product.reservedStock ?? 0) + line.quantity
        });
      }
      return createdOrder;
    });

    await audit("create_sales_order", `Created sales order ${order.id}`, {
      customerId: order.customerId,
      inventoryReservation: "reserved_on_order_confirmation"
    });
    return mapSalesOrder(order);
  }

  async addSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }) {
    await ensureSeeded();
    await ensureInventorySchema();
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
      if (String(existingOrder.status) === "canceled") {
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

      await applyInventoryMovementWithClient(tx, {
        productId: product.id,
        salesOrderId: existingOrder.id,
        type: "reservation",
        quantity: input.quantity,
        reason: `Reserva automatica do pedido ${existingOrder.id}`,
        nextAvailableStock: (current) => current.availableStock - input.quantity,
        nextReservedStock: (current) => (current.reservedStock ?? 0) + input.quantity
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
    await ensureInventorySchema();
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
      if (String(existingOrder.status) === "canceled") {
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
        await applyInventoryMovementWithClient(tx, {
          productId: product.id,
          salesOrderId: existingOrder.id,
          type: "reservation",
          quantity: delta,
          reason: `Reserva automatica do pedido ${existingOrder.id}`,
          nextAvailableStock: (current) => current.availableStock - delta,
          nextReservedStock: (current) => (current.reservedStock ?? 0) + delta
        });
      } else if (delta < 0) {
        const releaseQuantity = Math.abs(delta);
        await applyInventoryMovementWithClient(tx, {
          productId: input.productId,
          salesOrderId: existingOrder.id,
          type: "reservation_release",
          quantity: releaseQuantity,
          reason: `Liberacao automatica do pedido ${existingOrder.id}`,
          nextAvailableStock: (current) => current.availableStock + releaseQuantity,
          nextReservedStock: (current) => (current.reservedStock ?? 0) - releaseQuantity
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
    await ensureInventorySchema();
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
      if (String(existingOrder.status) === "canceled") {
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
      await applyInventoryMovementWithClient(tx, {
        productId: input.productId,
        salesOrderId: existingOrder.id,
        type: "reservation_release",
        quantity: currentLine.quantity,
        reason: `Liberacao automatica do pedido ${existingOrder.id}`,
        nextAvailableStock: (current) => current.availableStock + currentLine.quantity,
        nextReservedStock: (current) => (current.reservedStock ?? 0) - currentLine.quantity
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

  async applySalesOrderDiscount(input: {
    salesOrderId: string;
    productId?: string | null;
    discountType: "percent" | "amount";
    value: number;
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
      if (String(existingOrder.status) === "canceled") {
        throw new Error(`Sales order ${input.salesOrderId} is canceled and cannot be changed.`);
      }

      const targetLines = input.productId
        ? existingOrder.lines.filter((line) => line.productId === input.productId)
        : existingOrder.lines;
      if (!targetLines.length) {
        throw new Error(input.productId
          ? `Product ${input.productId} is not in sales order ${input.salesOrderId}.`
          : `Sales order ${input.salesOrderId} has no items.`);
      }

      const currentTotalCents = targetLines.reduce((sum, line) => sum + line.totalCents, 0);
      const discountCents = input.discountType === "percent"
        ? Math.round(currentTotalCents * (input.value / 100))
        : toCents(input.value);
      if (input.discountType === "percent" && input.value > 100) {
        throw new Error("Discount percent cannot be greater than 100.");
      }
      if (discountCents <= 0) {
        throw new Error("Discount must be greater than zero.");
      }
      if (discountCents > currentTotalCents) {
        throw new Error("Discount cannot be greater than the selected total.");
      }

      let distributedDiscountCents = 0;
      for (let index = 0; index < targetLines.length; index += 1) {
        const line = targetLines[index]!;
        const lineDiscountCents = index === targetLines.length - 1
          ? discountCents - distributedDiscountCents
          : Math.round(discountCents * (line.totalCents / currentTotalCents));
        distributedDiscountCents += lineDiscountCents;
        await tx.salesOrderLine.update({
          where: { id: line.id },
          data: {
            totalCents: line.totalCents - lineDiscountCents
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

    await audit("apply_sales_order_discount", `Applied discount to sales order ${order.id}`, {
      salesOrderId: order.id,
      productId: input.productId ?? null,
      discountType: input.discountType,
      value: input.value
    });
    return mapSalesOrder(order);
  }

  async cancelSalesOrder(input: { salesOrderId: string }) {
    await ensureSeeded();
    await ensureInventorySchema();
    const currentOrder = await fetchSalesOrderRaw(input.salesOrderId);
    if (!currentOrder) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    if (String(currentOrder.status) === "canceled") {
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

      if (String(existingOrder.status) !== "canceled") {
        const existingWriteOffs = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
          'SELECT COUNT(*)::bigint AS count FROM "InventoryMovement" WHERE "salesOrderId" = $1 AND type = $2',
          existingOrder.id,
          "order_writeoff"
        );
        const alreadyWroteOff = Number(existingWriteOffs[0]?.count ?? 0) > 0;
        if (!alreadyWroteOff) {
          for (const line of existingOrder.lines) {
            await applyInventoryMovementWithClient(tx, {
              productId: line.productId,
              salesOrderId: existingOrder.id,
              type: "reservation_release",
              quantity: line.quantity,
              reason: `Cancelamento do pedido ${existingOrder.id}`,
              nextAvailableStock: (current) => current.availableStock + line.quantity,
              nextReservedStock: (current) => (current.reservedStock ?? 0) - line.quantity
            });
          }
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
    await ensureInventorySchema();
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
        await applyInventoryMovementWithClient(tx, {
          productId: line.productId,
          salesOrderId: id,
          type: "reservation",
          quantity: line.quantity,
          reason: `Reserva automatica do pedido ${id}`,
          nextAvailableStock: (current) => current.availableStock - line.quantity,
          nextReservedStock: (current) => (current.reservedStock ?? 0) + line.quantity
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
    await ensureInvoiceSchema();
    await ensureInventorySchema();
    const invoiceId = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: input.salesOrderId },
        include: {
          lines: true,
          customer: true
        }
      });
      const existingWriteOffs = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*)::bigint AS count FROM "InventoryMovement" WHERE "salesOrderId" = $1 AND type = $2',
        order.id,
        "order_writeoff"
      );
      const alreadyWroteOff = Number(existingWriteOffs[0]?.count ?? 0) > 0;
      if (!alreadyWroteOff) {
        for (const line of order.lines) {
          await applyInventoryMovementWithClient(tx, {
            productId: line.productId,
            salesOrderId: order.id,
            type: "order_writeoff",
            quantity: line.quantity,
            reason: `Baixa automatica pela nota fiscal do pedido ${order.id}`,
            nextAvailableStock: (product) => {
              const reservedToConsume = Math.min(product.reservedStock ?? 0, line.quantity);
              const remaining = line.quantity - reservedToConsume;
              return product.availableStock - remaining;
            },
            nextReservedStock: (product) => (product.reservedStock ?? 0) - Math.min(product.reservedStock ?? 0, line.quantity)
          });
        }
      }
      const id = await nextBusinessId(tx, "concept_invoice", "CI", 5001);
      const amountCents = order.lines.reduce((sum: number, line: { totalCents: number }) => sum + line.totalCents, 0);
      await tx.$executeRawUnsafe(
        `
          INSERT INTO "ConceptInvoice" (
            id,
            "salesOrderId",
            "amountCents",
            disclaimer,
            status,
            "sourceOrderUpdatedAt",
            "sourceOrderAmountCents"
          )
          VALUES ($1, $2, $3, $4, 'issued', NOW(), $3)
        `,
        id,
        order.id,
        amountCents,
        "Concept invoice for portfolio demo only. Not a fiscal document."
      );
      return id;
    });

    const conceptInvoice = await fetchConceptInvoiceRaw(invoiceId);
    if (!conceptInvoice) {
      throw new Error(`Concept invoice ${invoiceId} not found after creation.`);
    }

    await audit("create_concept_invoice", `Created concept invoice ${conceptInvoice.id}`, {
      salesOrderId: conceptInvoice.salesOrderId,
      amount: conceptInvoice.amount
    });
    return conceptInvoice;
  }

  async cancelConceptInvoice(input: { invoiceId: string }) {
    await ensureSeeded();
    await ensureInvoiceSchema();
    const invoice = await fetchConceptInvoiceRaw(input.invoiceId);
    if (!invoice) {
      throw new Error(`Concept invoice ${input.invoiceId} not found.`);
    }
    if (invoice.status !== "canceled") {
      await prisma.$executeRawUnsafe(
        'UPDATE "ConceptInvoice" SET status = $1, "canceledAt" = NOW() WHERE id = $2',
        "canceled",
        input.invoiceId
      );
    }
    const canceledInvoice = await fetchConceptInvoiceRaw(input.invoiceId);
    if (!canceledInvoice) {
      throw new Error(`Concept invoice ${input.invoiceId} not found after cancellation.`);
    }
    await audit("cancel_concept_invoice", `Canceled concept invoice ${input.invoiceId}`, {
      invoiceId: input.invoiceId
    });
    return canceledInvoice;
  }

  async reissueConceptInvoice(input: { invoiceId: string }) {
    await ensureSeeded();
    await ensureInvoiceSchema();
    const sourceInvoice = await fetchConceptInvoiceRaw(input.invoiceId);
    if (!sourceInvoice) {
      throw new Error(`Concept invoice ${input.invoiceId} not found.`);
    }

    const newInvoiceId = await prisma.$transaction(async (tx: PrismaTransaction) => {
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: sourceInvoice.salesOrderId },
        include: {
          lines: true
        }
      });
      const id = await nextBusinessId(tx, "concept_invoice", "CI", 5001);
      const amountCents = order.lines.reduce((sum: number, line: { totalCents: number }) => sum + line.totalCents, 0);
      await tx.$executeRawUnsafe(
        'UPDATE "ConceptInvoice" SET status = $1, "canceledAt" = COALESCE("canceledAt", NOW()), "replacedByInvoiceId" = $2 WHERE id = $3',
        "reissued",
        id,
        sourceInvoice.id
      );
      await tx.$executeRawUnsafe(
        `
          INSERT INTO "ConceptInvoice" (
            id,
            "salesOrderId",
            "amountCents",
            disclaimer,
            status,
            "reissuedFromInvoiceId",
            "sourceOrderUpdatedAt",
            "sourceOrderAmountCents"
          )
          VALUES ($1, $2, $3, $4, 'issued', $5, NOW(), $3)
        `,
        id,
        sourceInvoice.salesOrderId,
        amountCents,
        "Concept invoice for portfolio demo only. Not a fiscal document.",
        sourceInvoice.id
      );
      return id;
    });

    const invoice = await fetchConceptInvoiceRaw(newInvoiceId);
    if (!invoice) {
      throw new Error(`Concept invoice ${newInvoiceId} not found after reissue.`);
    }
    await audit("reissue_concept_invoice", `Reissued concept invoice ${sourceInvoice.id} as ${invoice.id}`, {
      invoiceId: invoice.id,
      sourceInvoiceId: sourceInvoice.id,
      salesOrderId: invoice.salesOrderId
    });
    return invoice;
  }

  async getConceptInvoice(input: { invoiceId: string }) {
    await ensureSeeded();
    const invoice = await fetchConceptInvoiceRaw(input.invoiceId);
    await audit("get_concept_invoice", `Fetched concept invoice ${input.invoiceId}`);
    return invoice;
  }

  async listConceptInvoices(input: ListConceptInvoicesInput = {}) {
    await ensureSeeded();
    const invoices = await fetchConceptInvoicesRaw(input);
    await audit("list_concept_invoices", "Listed concept invoices", {
      salesOrderId: input.salesOrderId ?? null,
      dateRange: input.dateRange ?? "all_time",
      status: input.status ?? null,
      resultCount: invoices.length
    });
    return invoices;
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
    dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time";
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

  async queryManagerialReport(input: QueryManagerialReportInput) {
    await ensureSeeded();
    await ensureProductSchema();
    const kind = input.kind ?? inferManagerialReportKind(input.question ?? "");
    const dateRange = input.dateRange ?? "all_time";
    const take = input.take ?? 10;
    const orders = await fetchSalesOrdersRaw({
      dateRange,
      status: "confirmed",
      take: 500
    });
    const products = (await prisma.$queryRawUnsafe<DbProduct[]>(
      'SELECT id, sku, name, "unitPriceCents", "availableStock", "reservedStock", status FROM "Product" ORDER BY name ASC'
    )).map(mapProduct);
    const customers = await prisma.customer.findMany({
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" }
    });
    const report = buildManagerialReport({
      kind,
      dateRange,
      take,
      orders,
      products,
      customers,
      dataSource: "postgres"
    });
    await audit("query_managerial_report", `Queried managerial report ${kind}`, {
      kind,
      dateRange,
      rowCount: report.rows.length
    });
    return report;
  }

  async queryIntelligentReport(input: { question: string }): Promise<IntelligentReport> {
    await ensureSeeded();
    return queryIntelligentReportFromSql({
      question: input.question,
      dataSource: "postgres",
      runQuery: async (sql) => {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql);
        return rows.map(normalizeIntelligentReportRow);
      }
    });
  }
}

function normalizeIntelligentReportRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value instanceof Date) {
        return [key, value.toISOString()];
      }
      if (typeof value === "bigint") {
        return [key, Number(value)];
      }
      if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
        return [key, value.toNumber()];
      }
      if (value === undefined) {
        return [key, null];
      }
      return [key, value as string | number | boolean | null];
    })
  );
}

function resolveExplicitDateRange(dateFrom?: string | null, dateTo?: string | null) {
  if (!dateFrom && !dateTo) {
    return null;
  }
  const start = dateFrom ? new Date(`${dateFrom}T00:00:00.000`) : new Date(0);
  const end = dateTo ? new Date(`${dateTo}T00:00:00.000`) : new Date();
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function resolveDateRange(dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time") {
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
  if (dateRange === "last_30_days") {
    start.setDate(start.getDate() - 30);
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
  dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time";
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

function inferManagerialReportKind(question: string): ManagerialReportKind {
  const normalized = normalize(question);
  if (/\b(margem|lucro|rentabilidade)\b/.test(normalized)) return "margin";
  if (/\b(ruptura|estoque baixo|sem estoque|risco de estoque|repor|reposicao)\b/.test(normalized)) return "stockout_risk";
  if (/\b(cliente|clientes|ativos|recorrentes)\b/.test(normalized)) return "active_customers";
  if (/\b(tendencia|evolucao|crescimento|queda|por dia)\b/.test(normalized)) return "trend";
  if (/\b(ranking|mais vendido|mais vendidos|top)\b/.test(normalized)) return "top_products";
  if (/\b(faturamento|receita)\b/.test(normalized)) return "revenue";
  return "sales_by_period";
}

function buildManagerialReport(input: {
  kind: ManagerialReportKind;
  dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time";
  take: number;
  orders: SalesOrder[];
  products: Product[];
  customers: Array<{ id: string; name: string; status: string }>;
  dataSource: "demo-memory" | "postgres";
}): ManagerialReport {
  const lines = input.orders.flatMap((order) => order.lines.map((line) => ({ order, line })));
  const revenue = lines.reduce((sum, item) => sum + item.line.total, 0);
  const units = lines.reduce((sum, item) => sum + item.line.quantity, 0);
  const marginValue = revenue * 0.35;
  const period = translateReportDateRange(input.dateRange);

  if (input.kind === "active_customers") {
    const rows = Array.from(groupByMap(input.orders, (order) => order.customer.name).entries())
      .map(([customer, orders]) => ({
        cliente: customer,
        pedidos: orders.length,
        faturamento: roundMoney(orders.flatMap((order) => order.lines).reduce((sum, line) => sum + line.total, 0)),
        ultimoPedido: orders.map((order) => order.createdAt).sort().at(-1) ?? "-"
      }))
      .sort((a, b) => Number(b.faturamento) - Number(a.faturamento))
      .slice(0, input.take);
    return managerialReport({
      kind: input.kind,
      title: `Clientes ativos - ${period}`,
      summary: `${rows.length} cliente(s) com pedido confirmado no periodo.`,
      dateRange: input.dateRange,
      dataSource: input.dataSource,
      columns: ["cliente", "pedidos", "faturamento", "ultimoPedido"],
      rows,
      insights: rows.length ? [`${rows[0]?.cliente} lidera em faturamento no periodo.`] : ["Nao ha clientes ativos no periodo."],
      entities: ["sales_orders", "customers"]
    });
  }

  if (input.kind === "stockout_risk") {
    const soldByProduct = sumBy(lines, (item) => item.line.productId, (item) => item.line.quantity);
    const rows = input.products
      .map((product) => {
        const sold = soldByProduct.get(product.id) ?? 0;
        const available = product.availableStock;
        const reserved = product.reservedStock ?? 0;
        const riskScore = available <= 0 ? 100 : sold > 0 ? Math.min(100, Math.round((sold / Math.max(available, 1)) * 25)) : available <= 10 ? 60 : 10;
        return {
          produto: product.name,
          disponivel: available,
          reservado: reserved,
          vendidoPeriodo: sold,
          risco: riskScore >= 80 ? "alto" : riskScore >= 50 ? "medio" : "baixo"
        };
      })
      .filter((row) => row.risco !== "baixo" || Number(row.disponivel) <= 10)
      .sort((a, b) => riskWeight(String(b.risco)) - riskWeight(String(a.risco)) || Number(a.disponivel) - Number(b.disponivel))
      .slice(0, input.take);
    return managerialReport({
      kind: input.kind,
      title: `Ruptura de estoque - ${period}`,
      summary: rows.length ? `${rows.length} produto(s) exigem atencao de estoque.` : "Nenhum risco relevante de ruptura encontrado.",
      dateRange: input.dateRange,
      dataSource: input.dataSource,
      columns: ["produto", "disponivel", "reservado", "vendidoPeriodo", "risco"],
      rows,
      insights: rows[0] ? [`Priorize ${rows[0].produto}: risco ${rows[0].risco}.`] : ["Estoque sem alerta critico no periodo."],
      entities: ["products", "sales_order_lines"]
    });
  }

  const rowsByProduct = Array.from(groupByMap(lines, (item) => item.line.name).entries())
    .map(([product, items]) => {
      const productRevenue = items.reduce((sum, item) => sum + item.line.total, 0);
      const quantity = items.reduce((sum, item) => sum + item.line.quantity, 0);
      return {
        produto: product,
        quantidade: quantity,
        faturamento: roundMoney(productRevenue),
        margemEstimada: roundMoney(productRevenue * 0.35),
        participacao: revenue ? `${Math.round((productRevenue / revenue) * 100)}%` : "0%"
      };
    })
    .sort((a, b) => Number(b.faturamento) - Number(a.faturamento))
    .slice(0, input.take);

  if (input.kind === "trend") {
    const rows = Array.from(groupByMap(input.orders, (order) => order.createdAt.slice(0, 10)).entries())
      .map(([dia, orders]) => ({
        dia,
        pedidos: orders.length,
        unidades: orders.flatMap((order) => order.lines).reduce((sum, line) => sum + line.quantity, 0),
        faturamento: roundMoney(orders.flatMap((order) => order.lines).reduce((sum, line) => sum + line.total, 0))
      }))
      .sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
    const first = Number(rows[0]?.faturamento ?? 0);
    const last = Number(rows.at(-1)?.faturamento ?? 0);
    const trend = rows.length < 2 ? "Dados insuficientes para tendencia." : last >= first ? "Tendencia de alta no faturamento." : "Tendencia de queda no faturamento.";
    return managerialReport({
      kind: input.kind,
      title: `Tendencia de vendas - ${period}`,
      summary: `${rows.length} dia(s) analisado(s), faturamento total ${formatReportMoney(revenue)}.`,
      dateRange: input.dateRange,
      dataSource: input.dataSource,
      columns: ["dia", "pedidos", "unidades", "faturamento"],
      rows,
      insights: [trend],
      entities: ["sales_orders", "sales_order_lines"]
    });
  }

  const titleByKind: Record<ManagerialReportKind, string> = {
    sales_by_period: `Vendas por periodo - ${period}`,
    top_products: `Produtos mais vendidos - ${period}`,
    active_customers: `Clientes ativos - ${period}`,
    margin: `Margem estimada - ${period}`,
    stockout_risk: `Ruptura de estoque - ${period}`,
    revenue: `Faturamento - ${period}`,
    ranking: `Ranking gerencial - ${period}`,
    trend: `Tendencia de vendas - ${period}`
  };

  return managerialReport({
    kind: input.kind,
    title: titleByKind[input.kind],
    summary: `${input.orders.length} pedido(s), ${units} unidade(s), ${formatReportMoney(revenue)} em faturamento${input.kind === "margin" ? ` e ${formatReportMoney(marginValue)} de margem estimada` : ""}.`,
    dateRange: input.dateRange,
    dataSource: input.dataSource,
    columns: ["produto", "quantidade", "faturamento", "margemEstimada", "participacao"],
    rows: rowsByProduct,
    insights: [
      rowsByProduct[0] ? `${rowsByProduct[0].produto} lidera com ${rowsByProduct[0].participacao} do faturamento.` : "Nao ha vendas no periodo.",
      input.kind === "margin" ? "Margem estimada usando custo padrao de 65% do preco de venda." : `Ticket medio: ${formatReportMoney(input.orders.length ? revenue / input.orders.length : 0)}.`
    ],
    entities: ["sales_orders", "sales_order_lines", "products"]
  });
}

function managerialReport(input: {
  kind: ManagerialReportKind;
  title: string;
  summary: string;
  dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time";
  dataSource: "demo-memory" | "postgres";
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  insights: string[];
  entities: ManagerialReport["query"]["entities"];
}): ManagerialReport {
  return {
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    dateRange: input.dateRange,
    dataSource: input.dataSource,
    columns: input.columns,
    rows: input.rows,
    insights: input.insights,
    query: {
      capability: "query_managerial_report",
      entities: input.entities,
      filters: [{ label: "period", value: input.dateRange.replaceAll("_", " ") }]
    }
  };
}

function groupByMap<T>(items: T[], keyFn: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

function sumBy<T>(items: T[], keyFn: (item: T) => string, valueFn: (item: T) => number) {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) ?? 0) + valueFn(item));
  }
  return map;
}

function riskWeight(value: string) {
  return value === "alto" ? 3 : value === "medio" ? 2 : 1;
}

function formatReportMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function translateReportDateRange(dateRange: "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time") {
  return dateRange === "today" ? "hoje" : dateRange === "last_7_days" ? "ultimos 7 dias" : dateRange === "last_30_days" ? "ultimos 30 dias" : dateRange === "month_to_date" ? "mes atual" : "todo o periodo";
}
