import {
  ConceptInvoiceSchema,
  CustomerSchema,
  ProductSchema,
  SupplierSchema,
  AnalyticsResultSchema,
  SalesOrderPreviewSchema,
  SalesOrderSchema
} from "@anti-erp/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { z } from "zod";
import { recordMcpCall } from "../observability/mcp-trace";
import type { CapabilityGateway } from "./types";

type McpServerRole =
  | "core"
  | "customers"
  | "products"
  | "suppliers"
  | "salesOrders"
  | "invoices"
  | "analytics";

const clientPromises = new Map<McpServerRole, Promise<Client>>();
const customerTools = new Set(["search_customer", "create_customer", "list_customers"]);
const productTools = new Set([
  "search_product",
  "create_product",
  "update_product",
  "validate_stock",
  "list_low_stock_products"
]);
const supplierTools = new Set(["create_supplier"]);
const salesOrderTools = new Set([
  "prepare_sales_order",
  "create_sales_order",
  "add_sales_order_line",
  "set_sales_order_line_quantity",
  "remove_sales_order_line",
  "get_sales_order",
  "list_recent_orders"
]);
const invoiceTools = new Set(["create_concept_invoice"]);
const analyticsTools = new Set(["get_traditional_erp_flow", "query_sales_metrics"]);
const MCP_CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? 5000);
const MCP_TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 8000);

const ToolTextResultSchema = z.object({
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string()
    }).passthrough()
  )
});

async function getClient(role: McpServerRole) {
  if (!clientPromises.has(role)) {
    clientPromises.set(
      role,
      withTimeout(
        createClient(role),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP server ${role} did not connect within ${MCP_CONNECT_TIMEOUT_MS}ms.`
      ).catch((error) => {
        clientPromises.delete(role);
        throw error;
      })
    );
  }
  return clientPromises.get(role)!;
}

async function createClient(role: McpServerRole) {
  const client = new Client({
    name: `anti-erp-command-center-${role}`,
    version: "0.1.0"
  });
  const transport = new StdioClientTransport({
    command: getServerCommand(role),
    args: getServerArgs(role).split(" "),
    cwd: getServerCwd(role),
    stderr: "pipe"
  });

  await client.connect(transport);
  return client;
}

function getServerCommand(role: McpServerRole) {
  if (role === "customers") {
    return process.env.MCP_CUSTOMERS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? process.execPath;
  }
  if (role === "products") {
    return process.env.MCP_PRODUCTS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? process.execPath;
  }
  if (role === "suppliers") {
    return process.env.MCP_SUPPLIERS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? process.execPath;
  }
  if (role === "salesOrders") {
    return process.env.MCP_SALES_ORDERS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? process.execPath;
  }
  if (role === "invoices") {
    return process.env.MCP_INVOICES_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? process.execPath;
  }
  if (role === "analytics") {
    return process.env.MCP_ANALYTICS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? process.execPath;
  }
  return process.env.MCP_CORE_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? process.execPath;
}

function getServerArgs(role: McpServerRole) {
  if (role === "customers") {
    return process.env.MCP_CUSTOMERS_ARGS ?? "--import tsx src/server.ts";
  }
  if (role === "products") {
    return process.env.MCP_PRODUCTS_ARGS ?? "--import tsx src/server.ts";
  }
  if (role === "suppliers") {
    return process.env.MCP_SUPPLIERS_ARGS ?? "--import tsx src/server.ts";
  }
  if (role === "salesOrders") {
    return process.env.MCP_SALES_ORDERS_ARGS ?? "--import tsx src/server.ts";
  }
  if (role === "invoices") {
    return process.env.MCP_INVOICES_ARGS ?? "--import tsx src/server.ts";
  }
  if (role === "analytics") {
    return process.env.MCP_ANALYTICS_ARGS ?? "--import tsx src/server.ts";
  }
  return process.env.MCP_CORE_ARGS ?? process.env.MCP_SERVER_ARGS ?? "--import tsx src/server.ts";
}

function getServerCwd(role: McpServerRole) {
  if (role === "customers") {
    return process.env.MCP_CUSTOMERS_CWD ?? process.env.MCP_SERVER_CWD ?? getDefaultServerCwd("mcp-customers");
  }
  if (role === "products") {
    return process.env.MCP_PRODUCTS_CWD ?? process.env.MCP_SERVER_CWD ?? getDefaultServerCwd("mcp-products");
  }
  if (role === "suppliers") {
    return process.env.MCP_SUPPLIERS_CWD ?? process.env.MCP_SERVER_CWD ?? getDefaultServerCwd("mcp-suppliers");
  }
  if (role === "salesOrders") {
    return process.env.MCP_SALES_ORDERS_CWD ?? process.env.MCP_SERVER_CWD ?? getDefaultServerCwd("mcp-sales-orders");
  }
  if (role === "invoices") {
    return process.env.MCP_INVOICES_CWD ?? process.env.MCP_SERVER_CWD ?? getDefaultServerCwd("mcp-invoices");
  }
  if (role === "analytics") {
    return process.env.MCP_ANALYTICS_CWD ?? process.env.MCP_SERVER_CWD ?? getDefaultServerCwd("mcp-analytics");
  }
  return process.env.MCP_CORE_CWD ?? process.env.MCP_SERVER_CWD ?? getDefaultServerCwd("mcp-server");
}

function getDefaultServerCwd(appName: string) {
  const cwd = process.cwd();
  if (path.basename(cwd) === "command-center") {
    return path.resolve(cwd, "..", appName);
  }
  return path.resolve(cwd, "apps", appName);
}

function getRoleForTool(name: string): McpServerRole {
  if (customerTools.has(name)) {
    return "customers";
  }
  if (productTools.has(name)) {
    return "products";
  }
  if (supplierTools.has(name)) {
    return "suppliers";
  }
  if (salesOrderTools.has(name)) {
    return "salesOrders";
  }
  if (invoiceTools.has(name)) {
    return "invoices";
  }
  if (analyticsTools.has(name)) {
    return "analytics";
  }
  return "core";
}

async function callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
  const role = getRoleForTool(name);
  const startedAt = performance.now();

  try {
    const client = await getClient(role);
    const result = await withTimeout(
      client.callTool({ name, arguments: args }),
      MCP_TOOL_TIMEOUT_MS,
      `MCP tool ${name} did not respond within ${MCP_TOOL_TIMEOUT_MS}ms.`
    );
    const parsedResult = ToolTextResultSchema.parse(result);
    const text = parsedResult.content[0]?.text;
    if (!text) {
      throw new Error(`MCP tool ${name} did not return text content.`);
    }
    const output = schema.parse(parseToolJson(name, text));
    await recordMcpCall({
      role,
      tool: name,
      status: "success",
      durationMs: performance.now() - startedAt,
      args,
      output
    });
    return output;
  } catch (error) {
    await recordMcpCall({
      role,
      tool: name,
      status: "error",
      durationMs: performance.now() - startedAt,
      args,
      error
    });
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function parseToolJson(name: string, text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text || `MCP tool ${name} returned invalid JSON.`);
  }
}

export class McpCapabilityGateway implements CapabilityGateway {
  async createCustomer(input: { name: string }) {
    return callTool("create_customer", input, CustomerSchema);
  }

  async listCustomers() {
    return callTool("list_customers", {}, z.array(CustomerSchema));
  }

  async createProduct(input: { name: string }) {
    return callTool("create_product", input, ProductSchema);
  }

  async createSupplier(input: { name: string }) {
    return callTool("create_supplier", input, SupplierSchema);
  }

  async updateProduct(input: {
    productId: string;
    unitPrice?: number | null;
    availableStock?: number | null;
  }) {
    return callTool("update_product", input, ProductSchema);
  }

  async searchCustomer(input: { query: string }) {
    return callTool("search_customer", input, z.array(CustomerSchema));
  }

  async searchProduct(input: { query: string }) {
    return callTool("search_product", input, z.array(ProductSchema));
  }

  async validateStock(input: { productId: string; quantity: number }) {
    return callTool(
      "validate_stock",
      input,
      z.object({
        productId: z.string(),
        requested: z.number(),
        available: z.number(),
        valid: z.boolean()
      })
    );
  }

  async listLowStockProducts(input: { threshold?: number } = {}) {
    return callTool("list_low_stock_products", input, z.array(ProductSchema));
  }

  async prepareSalesOrder(input: {
    customerId: string;
    lines: Array<{ productId: string; quantity: number }>;
  }) {
    return callTool("prepare_sales_order", input, SalesOrderPreviewSchema);
  }

  async createSalesOrder(input: {
    preview: z.infer<typeof SalesOrderPreviewSchema>;
    confirmedByUser: true;
  }) {
    return callTool("create_sales_order", input, SalesOrderSchema);
  }

  async addSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }) {
    return callTool("add_sales_order_line", input, SalesOrderSchema);
  }

  async setSalesOrderLineQuantity(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }) {
    return callTool("set_sales_order_line_quantity", input, SalesOrderSchema);
  }

  async removeSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
  }) {
    return callTool("remove_sales_order_line", input, SalesOrderSchema);
  }

  async createConceptInvoice(input: { salesOrderId: string }) {
    return callTool("create_concept_invoice", input, ConceptInvoiceSchema);
  }

  async getSalesOrder(input: { salesOrderId: string }) {
    return callTool("get_sales_order", input, SalesOrderSchema.nullable());
  }

  async listRecentOrders() {
    return callTool("list_recent_orders", {}, z.array(SalesOrderSchema));
  }

  async getTraditionalErpFlow() {
    return callTool(
      "get_traditional_erp_flow",
      {},
      z.object({
        traditional: z.array(z.string()),
        antiErp: z.array(z.string())
      })
    );
  }

  async querySalesMetrics(input: {
    metric: "units_sold" | "revenue" | "order_count";
    productQuery?: string | null;
    productQueries?: string[] | null;
    customerQuery?: string | null;
    dateRange: "today" | "last_7_days" | "month_to_date" | "all_time";
    groupBy?: "product" | "customer" | "day" | null;
  }) {
    return callTool("query_sales_metrics", input, AnalyticsResultSchema);
  }
}
