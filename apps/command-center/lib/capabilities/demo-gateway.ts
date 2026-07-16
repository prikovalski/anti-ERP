import {
  AnalyticsResult,
  ConceptInvoice,
  InventoryMovement,
  ListConceptInvoicesInput,
  ListInventoryMovementsInput,
  ListSalesOrdersInput,
  Product,
  SearchCatalogInput,
  SalesOrder,
  SalesOrderPreview,
  Supplier,
  demoCustomers,
  demoProducts
} from "@anti-erp/shared";
import type { CapabilityGateway } from "./types";

const salesOrders = new Map<string, SalesOrder>();
const invoices = new Map<string, ConceptInvoice>();
const inventoryMovements: InventoryMovement[] = [];
const suppliers = new Map<string, Supplier>();
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

function createInventoryMovementId() {
  return `IM-${Date.now()}-${randomToken().toUpperCase()}`;
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

function filterCatalogRecords<T extends { name: string; status?: string; sku?: string; taxId?: string }>(
  records: T[],
  input: SearchCatalogInput = {}
) {
  const query = normalize(input.query ?? "");
  const status = input.status === "inactive" ? "blocked" : input.status;
  return records
    .filter((record) => {
      if (status && record.status && record.status !== status && !(input.status === "inactive" && record.status === "inactive")) {
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

function recordInventoryMovement(input: {
  product: Product;
  salesOrderId?: string | null;
  type: InventoryMovement["type"];
  quantity: number;
  previousAvailableStock: number;
  previousReservedStock: number;
  reason?: string | null;
}): InventoryMovement {
  const movement: InventoryMovement = {
    id: createInventoryMovementId(),
    productId: input.product.id,
    sku: input.product.sku,
    productName: input.product.name,
    salesOrderId: input.salesOrderId ?? null,
    type: input.type,
    quantity: input.quantity,
    previousAvailableStock: input.previousAvailableStock,
    nextAvailableStock: input.product.availableStock,
    previousReservedStock: input.previousReservedStock,
    nextReservedStock: input.product.reservedStock ?? 0,
    reason: input.reason ?? null,
    createdAt: now()
  };
  inventoryMovements.unshift(movement);
  return movement;
}

export class DemoCapabilityGateway implements CapabilityGateway {
  private customers = [...demoCustomers];
  private products = [...demoProducts];

  private requireProduct(productId: string) {
    const product = this.products.find((candidate) => candidate.id === productId);
    if (!product) {
      throw new Error(`Product ${productId} not found.`);
    }
    product.reservedStock ??= 0;
    return product;
  }

  async createCustomer(input: { name: string }) {
    const name = cleanName(input.name);
    const normalizedName = normalize(name);
    const existing = this.customers.find((customer) => normalize(customer.name) === normalizedName);
    if (existing) {
      throw new Error(`Customer "${existing.name}" already exists.`);
    }
    const customer = {
      id: `cus_${slugify(name) || "customer"}_${randomToken()}`,
      name,
      taxId: `DEMO-CUS-${Date.now()}-${randomToken().toUpperCase()}`,
      city: "Nao informada",
      status: "active" as const
    };
    this.customers.push(customer);
    return customer;
  }

  async updateCustomer(input: {
    customerId: string;
    name?: string | null;
    city?: string | null;
    status?: "active" | "inactive" | "blocked" | null;
  }) {
    const customer = this.customers.find((candidate) => candidate.id === input.customerId);
    if (!customer) {
      throw new Error(`Customer ${input.customerId} not found.`);
    }
    if (input.name !== undefined && input.name !== null) {
      const name = cleanName(input.name);
      const existing = this.customers.find((candidate) => candidate.id !== customer.id && normalize(candidate.name) === normalize(name));
      if (existing) {
        throw new Error(`Customer "${existing.name}" already exists.`);
      }
      customer.name = name;
    }
    if (input.city !== undefined && input.city !== null) {
      customer.city = cleanName(input.city);
    }
    if (input.status) {
      customer.status = input.status === "active" ? "active" : "blocked";
    }
    return customer;
  }

  async listCustomers() {
    return [...this.customers].sort((a, b) => a.name.localeCompare(b.name));
  }

  async searchCustomersAdvanced(input: SearchCatalogInput = {}) {
    return filterCatalogRecords(this.customers, input);
  }

  async createProduct(input: { name: string }) {
    const name = cleanName(input.name);
    const normalizedName = normalize(name);
    const existing = this.products.find((product) => normalize(product.name) === normalizedName);
    if (existing) {
      throw new Error(`Product "${existing.name}" already exists.`);
    }
    const product = {
      id: `prd_${slugify(name) || "product"}_${randomToken()}`,
      sku: `SKU-${slugify(name).replaceAll("_", "-").toUpperCase() || "ITEM"}-${randomToken().toUpperCase()}`,
      name,
      unitPrice: 0,
      availableStock: 0,
      reservedStock: 0,
      status: "active" as const
    };
    this.products.push(product);
    return product;
  }

  async listProducts(input: SearchCatalogInput = {}) {
    return filterCatalogRecords(this.products, input);
  }

  async createSupplier(input: { name: string }) {
    const name = cleanName(input.name);
    const normalizedName = normalize(name);
    const existing = Array.from(suppliers.values()).find((supplier) => normalize(supplier.name) === normalizedName);
    if (existing) {
      throw new Error(`Supplier "${existing.name}" already exists.`);
    }
    const supplier = {
      id: `sup_${slugify(name) || "supplier"}_${randomToken()}`,
      name,
      status: "active" as const
    };
    suppliers.set(supplier.id, supplier);
    return supplier;
  }

  async updateSupplier(input: {
    supplierId: string;
    name?: string | null;
    status?: "active" | "inactive" | "blocked" | null;
  }) {
    const supplier = suppliers.get(input.supplierId);
    if (!supplier) {
      throw new Error(`Supplier ${input.supplierId} not found.`);
    }
    if (input.name !== undefined && input.name !== null) {
      const name = cleanName(input.name);
      const existing = Array.from(suppliers.values()).find((candidate) => candidate.id !== supplier.id && normalize(candidate.name) === normalize(name));
      if (existing) {
        throw new Error(`Supplier "${existing.name}" already exists.`);
      }
      supplier.name = name;
    }
    if (input.status) {
      supplier.status = input.status === "active" ? "active" : "blocked";
    }
    suppliers.set(supplier.id, supplier);
    return supplier;
  }

  async searchSupplier(input: { query: string }) {
    return this.listSuppliers({ query: input.query });
  }

  async listSuppliers(input: SearchCatalogInput = {}) {
    return filterCatalogRecords(Array.from(suppliers.values()), input);
  }

  async updateProduct(input: {
    productId: string;
    name?: string | null;
    unitPrice?: number | null;
    availableStock?: number | null;
    status?: "active" | "inactive" | null;
  }) {
    const product = this.products.find((candidate) => candidate.id === input.productId);
    if (!product) {
      throw new Error(`Product ${input.productId} not found.`);
    }
    if (input.name !== undefined && input.name !== null) {
      const name = cleanName(input.name);
      const existing = this.products.find((candidate) => candidate.id !== product.id && normalize(candidate.name) === normalize(name));
      if (existing) {
        throw new Error(`Product "${existing.name}" already exists.`);
      }
      product.name = name;
    }
    if (input.unitPrice !== undefined && input.unitPrice !== null) {
      product.unitPrice = input.unitPrice;
    }
    if (input.availableStock !== undefined && input.availableStock !== null) {
      product.availableStock = input.availableStock;
    }
    if (input.status !== undefined && input.status !== null) {
      product.status = input.status;
    }
    return product;
  }

  async searchCustomer(input: { query: string }) {
    const query = normalize(input.query);
    return this.customers.filter(
      (customer) => normalize(customer.name).includes(query) || customer.taxId.includes(input.query)
    );
  }

  async searchProduct(input: { query: string }) {
    return this.searchProductsAdvanced({ query: input.query });
  }

  async searchProductsAdvanced(input: SearchCatalogInput = {}) {
    return this.listProducts(input);
  }

  async validateStock(input: { productId: string; quantity: number }) {
    const product = this.products.find((candidate) => candidate.id === input.productId);
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

  async listLowStockProducts(input: { threshold?: number } = {}) {
    const threshold = input.threshold ?? 10;
    return this.products
      .filter((product) => product.availableStock <= threshold)
      .sort((a, b) => a.availableStock - b.availableStock || a.name.localeCompare(b.name));
  }

  async createInventoryEntry(input: { productId: string; quantity: number; reason?: string | null }) {
    const product = this.requireProduct(input.productId);
    const previousAvailableStock = product.availableStock;
    const previousReservedStock = product.reservedStock ?? 0;
    product.availableStock += input.quantity;
    return recordInventoryMovement({
      product,
      type: "entry",
      quantity: input.quantity,
      previousAvailableStock,
      previousReservedStock,
      reason: input.reason ?? "Entrada de estoque"
    });
  }

  async createInventoryExit(input: { productId: string; quantity: number; reason?: string | null }) {
    const product = this.requireProduct(input.productId);
    const previousAvailableStock = product.availableStock;
    const previousReservedStock = product.reservedStock ?? 0;
    if (product.availableStock < input.quantity) {
      throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
    }
    product.availableStock -= input.quantity;
    return recordInventoryMovement({
      product,
      type: "exit",
      quantity: input.quantity,
      previousAvailableStock,
      previousReservedStock,
      reason: input.reason ?? "Saida de estoque"
    });
  }

  async adjustInventory(input: { productId: string; quantity: number; reason?: string | null }) {
    const product = this.requireProduct(input.productId);
    const previousAvailableStock = product.availableStock;
    const previousReservedStock = product.reservedStock ?? 0;
    product.availableStock = input.quantity;
    return recordInventoryMovement({
      product,
      type: "adjustment",
      quantity: input.quantity,
      previousAvailableStock,
      previousReservedStock,
      reason: input.reason ?? "Ajuste manual de estoque"
    });
  }

  async reserveInventory(input: {
    productId: string;
    quantity: number;
    salesOrderId?: string | null;
    reason?: string | null;
  }) {
    const product = this.requireProduct(input.productId);
    const previousAvailableStock = product.availableStock;
    const previousReservedStock = product.reservedStock ?? 0;
    if (product.availableStock < input.quantity) {
      throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
    }
    product.availableStock -= input.quantity;
    product.reservedStock = previousReservedStock + input.quantity;
    return recordInventoryMovement({
      product,
      salesOrderId: input.salesOrderId ?? null,
      type: "reservation",
      quantity: input.quantity,
      previousAvailableStock,
      previousReservedStock,
      reason: input.reason ?? "Reserva de estoque"
    });
  }

  async releaseInventoryReservation(input: {
    productId: string;
    quantity: number;
    salesOrderId?: string | null;
    reason?: string | null;
  }) {
    const product = this.requireProduct(input.productId);
    const previousAvailableStock = product.availableStock;
    const previousReservedStock = product.reservedStock ?? 0;
    if (previousReservedStock < input.quantity) {
      throw new Error(`${product.sku} has only ${previousReservedStock} reserved units.`);
    }
    product.availableStock += input.quantity;
    product.reservedStock = previousReservedStock - input.quantity;
    return recordInventoryMovement({
      product,
      salesOrderId: input.salesOrderId ?? null,
      type: "reservation_release",
      quantity: input.quantity,
      previousAvailableStock,
      previousReservedStock,
      reason: input.reason ?? "Liberacao de reserva"
    });
  }

  async writeOffInventoryForSalesOrder(input: { salesOrderId: string; reason?: string | null }) {
    const order = salesOrders.get(input.salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    const movements: InventoryMovement[] = [];
    for (const line of order.lines) {
      const product = this.requireProduct(line.productId);
      const previousAvailableStock = product.availableStock;
      const previousReservedStock = product.reservedStock ?? 0;
      const reservedToConsume = Math.min(previousReservedStock, line.quantity);
      product.reservedStock = previousReservedStock - reservedToConsume;
      const remaining = line.quantity - reservedToConsume;
      if (remaining > 0) {
        if (product.availableStock < remaining) {
          throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
        }
        product.availableStock -= remaining;
      }
      movements.push(recordInventoryMovement({
        product,
        salesOrderId: order.id,
        type: "order_writeoff",
        quantity: line.quantity,
        previousAvailableStock,
        previousReservedStock,
        reason: input.reason ?? `Baixa por pedido ${order.id}`
      }));
    }
    return movements;
  }

  async listInventoryMovements(input: ListInventoryMovementsInput = {}) {
    return inventoryMovements
      .filter((movement) => !input.productId || movement.productId === input.productId)
      .filter((movement) => !input.salesOrderId || movement.salesOrderId === input.salesOrderId)
      .filter((movement) => !input.type || movement.type === input.type)
      .filter((movement) => isInsideDateRange(movement.createdAt, input.dateRange ?? "all_time"))
      .slice(0, input.take ?? 25);
  }

  async prepareSalesOrder(input: {
    customerId: string;
    lines: Array<{ productId: string; quantity: number }>;
  }) {
    const customer = this.customers.find((candidate) => candidate.id === input.customerId);
    if (!customer) {
      throw new Error(`Customer ${input.customerId} not found.`);
    }

    const warnings: string[] = [];
    if (customer.status === "blocked") {
      warnings.push("Customer is blocked. Human review is required before confirmation.");
    }

    const lines = input.lines.map((line) => {
      const product = this.products.find((candidate) => candidate.id === line.productId);
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

  async addSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }) {
    const order = salesOrders.get(input.salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    if (order.status === "canceled") {
      throw new Error(`Sales order ${input.salesOrderId} is canceled and cannot be changed.`);
    }
    const product = this.products.find((candidate) => candidate.id === input.productId);
    if (!product) {
      throw new Error(`Product ${input.productId} not found.`);
    }
    if (product.availableStock < input.quantity) {
      throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
    }

    const currentLine = order.lines.find((line) => line.productId === product.id);
    if (currentLine) {
      currentLine.quantity += input.quantity;
      currentLine.unitPrice = product.unitPrice;
      currentLine.total = currentLine.quantity * product.unitPrice;
    } else {
      order.lines.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        quantity: input.quantity,
        unitPrice: product.unitPrice,
        total: input.quantity * product.unitPrice
      });
    }
    product.availableStock -= input.quantity;
    order.subtotal = order.lines.reduce((sum, line) => sum + line.total, 0);
    salesOrders.set(order.id, order);
    return order;
  }

  async setSalesOrderLineQuantity(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }) {
    const order = salesOrders.get(input.salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    if (order.status === "canceled") {
      throw new Error(`Sales order ${input.salesOrderId} is canceled and cannot be changed.`);
    }
    const product = this.products.find((candidate) => candidate.id === input.productId);
    if (!product) {
      throw new Error(`Product ${input.productId} not found.`);
    }
    const currentLine = order.lines.find((line) => line.productId === product.id);
    if (!currentLine) {
      throw new Error(`Product ${input.productId} is not in sales order ${input.salesOrderId}.`);
    }
    if (input.quantity === 0 && order.lines.length === 1) {
      throw new Error(`Sales order ${input.salesOrderId} must keep at least one item.`);
    }

    const delta = input.quantity - currentLine.quantity;
    if (delta > 0 && product.availableStock < delta) {
      throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
    }
    product.availableStock -= delta;

    if (input.quantity === 0) {
      order.lines = order.lines.filter((line) => line.productId !== product.id);
    } else {
      currentLine.quantity = input.quantity;
      currentLine.unitPrice = product.unitPrice;
      currentLine.total = input.quantity * product.unitPrice;
    }
    order.subtotal = order.lines.reduce((sum, line) => sum + line.total, 0);
    salesOrders.set(order.id, order);
    return order;
  }

  async removeSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
  }) {
    const order = salesOrders.get(input.salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    if (order.status === "canceled") {
      throw new Error(`Sales order ${input.salesOrderId} is canceled and cannot be changed.`);
    }
    const product = this.products.find((candidate) => candidate.id === input.productId);
    if (!product) {
      throw new Error(`Product ${input.productId} not found.`);
    }
    const currentLine = order.lines.find((line) => line.productId === product.id);
    if (!currentLine) {
      throw new Error(`Product ${input.productId} is not in sales order ${input.salesOrderId}.`);
    }
    if (order.lines.length === 1) {
      throw new Error(`Sales order ${input.salesOrderId} must keep at least one item.`);
    }

    product.availableStock += currentLine.quantity;
    order.lines = order.lines.filter((line) => line.productId !== product.id);
    order.subtotal = order.lines.reduce((sum, line) => sum + line.total, 0);
    salesOrders.set(order.id, order);
    return order;
  }

  async cancelSalesOrder(input: { salesOrderId: string }) {
    const order = salesOrders.get(input.salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    if (order.status !== "canceled") {
      for (const line of order.lines) {
        const product = this.products.find((candidate) => candidate.id === line.productId);
        if (product) {
          product.availableStock += line.quantity;
        }
      }
      order.status = "canceled";
      salesOrders.set(order.id, order);
    }
    return order;
  }

  async duplicateSalesOrder(input: { salesOrderId: string }) {
    const sourceOrder = salesOrders.get(input.salesOrderId);
    if (!sourceOrder) {
      throw new Error(`Sales order ${input.salesOrderId} not found.`);
    }
    if (sourceOrder.lines.length === 0) {
      throw new Error(`Sales order ${input.salesOrderId} has no items to duplicate.`);
    }

    for (const line of sourceOrder.lines) {
      const product = this.products.find((candidate) => candidate.id === line.productId);
      if (!product) {
        throw new Error(`Product ${line.productId} not found.`);
      }
      if (product.availableStock < line.quantity) {
        throw new Error(`${product.sku} has only ${product.availableStock} units available.`);
      }
    }

    for (const line of sourceOrder.lines) {
      const product = this.products.find((candidate) => candidate.id === line.productId);
      if (product) {
        product.availableStock -= line.quantity;
      }
    }

    const order: SalesOrder = {
      ...sourceOrder,
      id: createSalesOrderId(),
      status: "confirmed",
      createdAt: now(),
      lines: sourceOrder.lines.map((line) => ({ ...line }))
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
      disclaimer: "Concept invoice for portfolio demo only. Not a fiscal document.",
      status: "issued",
      canceledAt: null,
      reissuedFromInvoiceId: null,
      replacedByInvoiceId: null,
      sourceOrderUpdatedAt: now(),
      orderChangedAfterIssue: false
    };
    invoices.set(invoice.id, invoice);
    return invoice;
  }

  async cancelConceptInvoice(input: { invoiceId: string }) {
    const invoice = invoices.get(input.invoiceId);
    if (!invoice) {
      throw new Error(`Concept invoice ${input.invoiceId} not found.`);
    }
    if (invoice.status !== "canceled") {
      invoice.status = "canceled";
      invoice.canceledAt = now();
      invoices.set(invoice.id, invoice);
    }
    return invoice;
  }

  async reissueConceptInvoice(input: { invoiceId: string }) {
    const sourceInvoice = invoices.get(input.invoiceId);
    if (!sourceInvoice) {
      throw new Error(`Concept invoice ${input.invoiceId} not found.`);
    }
    const order = salesOrders.get(sourceInvoice.salesOrderId);
    if (!order) {
      throw new Error(`Sales order ${sourceInvoice.salesOrderId} not found.`);
    }
    const invoice: ConceptInvoice = {
      id: createConceptInvoiceId(),
      salesOrderId: order.id,
      customerName: order.customer.name,
      amount: order.subtotal,
      issuedAt: now(),
      disclaimer: "Concept invoice for portfolio demo only. Not a fiscal document.",
      status: "issued",
      canceledAt: null,
      reissuedFromInvoiceId: sourceInvoice.id,
      replacedByInvoiceId: null,
      sourceOrderUpdatedAt: now(),
      orderChangedAfterIssue: false
    };
    sourceInvoice.status = "reissued";
    sourceInvoice.canceledAt ??= now();
    sourceInvoice.replacedByInvoiceId = invoice.id;
    invoices.set(sourceInvoice.id, sourceInvoice);
    invoices.set(invoice.id, invoice);
    return invoice;
  }

  async getConceptInvoice(input: { invoiceId: string }) {
    const invoice = invoices.get(input.invoiceId) ?? null;
    if (!invoice) {
      return null;
    }
    const order = salesOrders.get(invoice.salesOrderId);
    return {
      ...invoice,
      orderChangedAfterIssue: order ? order.subtotal !== invoice.amount : invoice.orderChangedAfterIssue
    };
  }

  async listConceptInvoices(input: ListConceptInvoicesInput = {}) {
    const take = input.take ?? 25;
    return Array.from(invoices.values())
      .map((invoice) => {
        const order = salesOrders.get(invoice.salesOrderId);
        return {
          ...invoice,
          orderChangedAfterIssue: order ? order.subtotal !== invoice.amount : invoice.orderChangedAfterIssue
        };
      })
      .filter((invoice) => !input.salesOrderId || invoice.salesOrderId === input.salesOrderId)
      .filter((invoice) => !input.status || invoice.status === input.status)
      .filter((invoice) => isInsideDateRange(invoice.issuedAt, input.dateRange ?? "all_time"))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
      .slice(0, take);
  }

  async getSalesOrder(input: { salesOrderId: string }) {
    return salesOrders.get(input.salesOrderId) ?? null;
  }

  async listSalesOrders(input: ListSalesOrdersInput = {}) {
    const customerQuery = normalize(input.customerQuery ?? "");
    const take = input.take ?? 25;
    return Array.from(salesOrders.values())
      .filter((order) => !input.status || order.status === input.status)
      .filter((order) => isInsideDateRange(order.createdAt, input.dateRange ?? "all_time"))
      .filter((order) => !customerQuery || normalize(order.customer.name).includes(customerQuery))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, take);
  }

  async listRecentOrders() {
    return this.listSalesOrders({ take: 10 });
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
      const matchesDateRange = isInsideDateRange(order.createdAt, input.dateRange);
      const matchesCustomer = customerQuery ? normalize(order.customer.name).includes(customerQuery) : true;
      const matchesProduct = query
        ? order.lines.some((line) => normalize(line.name).includes(query) || normalize(line.sku).includes(query))
        : true;
      return matchesDateRange && matchesCustomer && matchesProduct;
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
      query: buildAnalyticsQuery({
        ...input,
        dataSource: "demo-memory"
      }),
      rows: buildMetricRows(input.groupBy, input.metric, filteredOrders)
    } satisfies AnalyticsResult;
  }
}

export const demoCapabilityGateway = new DemoCapabilityGateway();

function buildMetricLabel(metric: string, productQuery: string | null | undefined, dateRange: string) {
  const subject = productQuery ? productQuery : "sales";
  const period = dateRange === "today" ? "today" : dateRange.replaceAll("_", " ");
  return `${metric.replaceAll("_", " ")} for ${subject} ${period}`;
}

function isInsideDateRange(createdAt: string, dateRange: "today" | "last_7_days" | "month_to_date" | "all_time") {
  if (dateRange === "all_time") {
    return true;
  }

  const date = new Date(createdAt);
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
  return date >= start && date < now;
}

function buildAnalyticsQuery(input: {
  productQuery?: string | null;
  customerQuery?: string | null;
  dateRange: "today" | "last_7_days" | "month_to_date" | "all_time";
  groupBy?: "product" | "customer" | "day" | null;
  dataSource: "demo-memory";
}) {
  const entities: AnalyticsResult["query"]["entities"] = ["sales_orders", "sales_order_lines", "customers", "products"];

  return {
    capability: "query_sales_metrics" as const,
    entities,
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
