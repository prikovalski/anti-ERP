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
const customerTools = new Set(["search_customer", "create_customer"]);
const productTools = new Set([
  "search_product",
  "create_product",
  "update_product",
  "validate_stock"
]);
const supplierTools = new Set(["create_supplier"]);
const salesOrderTools = new Set([
  "prepare_sales_order",
  "create_sales_order",
  "get_sales_order",
  "list_recent_orders"
]);
const invoiceTools = new Set(["create_concept_invoice"]);
const analyticsTools = new Set(["get_traditional_erp_flow", "query_sales_metrics"]);

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
    clientPromises.set(role, createClient(role));
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
    return process.env.MCP_CUSTOMERS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? "pnpm";
  }
  if (role === "products") {
    return process.env.MCP_PRODUCTS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? "pnpm";
  }
  if (role === "suppliers") {
    return process.env.MCP_SUPPLIERS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? "pnpm";
  }
  if (role === "salesOrders") {
    return process.env.MCP_SALES_ORDERS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? "pnpm";
  }
  if (role === "invoices") {
    return process.env.MCP_INVOICES_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? "pnpm";
  }
  if (role === "analytics") {
    return process.env.MCP_ANALYTICS_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? "pnpm";
  }
  return process.env.MCP_CORE_COMMAND ?? process.env.MCP_SERVER_COMMAND ?? "pnpm";
}

function getServerArgs(role: McpServerRole) {
  if (role === "customers") {
    return process.env.MCP_CUSTOMERS_ARGS ?? "--filter @anti-erp/mcp-customers dev";
  }
  if (role === "products") {
    return process.env.MCP_PRODUCTS_ARGS ?? "--filter @anti-erp/mcp-products dev";
  }
  if (role === "suppliers") {
    return process.env.MCP_SUPPLIERS_ARGS ?? "--filter @anti-erp/mcp-suppliers dev";
  }
  if (role === "salesOrders") {
    return process.env.MCP_SALES_ORDERS_ARGS ?? "--filter @anti-erp/mcp-sales-orders dev";
  }
  if (role === "invoices") {
    return process.env.MCP_INVOICES_ARGS ?? "--filter @anti-erp/mcp-invoices dev";
  }
  if (role === "analytics") {
    return process.env.MCP_ANALYTICS_ARGS ?? "--filter @anti-erp/mcp-analytics dev";
  }
  return process.env.MCP_CORE_ARGS ?? process.env.MCP_SERVER_ARGS ?? "--filter @anti-erp/mcp-server dev";
}

function getServerCwd(role: McpServerRole) {
  if (role === "customers") {
    return process.env.MCP_CUSTOMERS_CWD ?? process.env.MCP_SERVER_CWD ?? process.cwd();
  }
  if (role === "products") {
    return process.env.MCP_PRODUCTS_CWD ?? process.env.MCP_SERVER_CWD ?? process.cwd();
  }
  if (role === "suppliers") {
    return process.env.MCP_SUPPLIERS_CWD ?? process.env.MCP_SERVER_CWD ?? process.cwd();
  }
  if (role === "salesOrders") {
    return process.env.MCP_SALES_ORDERS_CWD ?? process.env.MCP_SERVER_CWD ?? process.cwd();
  }
  if (role === "invoices") {
    return process.env.MCP_INVOICES_CWD ?? process.env.MCP_SERVER_CWD ?? process.cwd();
  }
  if (role === "analytics") {
    return process.env.MCP_ANALYTICS_CWD ?? process.env.MCP_SERVER_CWD ?? process.cwd();
  }
  return process.env.MCP_CORE_CWD ?? process.env.MCP_SERVER_CWD ?? process.cwd();
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
    const result = await client.callTool({ name, arguments: args });
    const parsedResult = ToolTextResultSchema.parse(result);
    const text = parsedResult.content[0]?.text;
    if (!text) {
      throw new Error(`MCP tool ${name} did not return text content.`);
    }
    const output = schema.parse(JSON.parse(text));
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

export class McpCapabilityGateway implements CapabilityGateway {
  async createCustomer(input: { name: string }) {
    return callTool("create_customer", input, CustomerSchema);
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
    customerQuery?: string | null;
    dateRange: "today" | "last_7_days" | "month_to_date" | "all_time";
    groupBy?: "product" | "customer" | "day" | null;
  }) {
    return callTool("query_sales_metrics", input, AnalyticsResultSchema);
  }
}
