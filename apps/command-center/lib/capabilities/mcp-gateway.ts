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
import type { CapabilityGateway } from "./types";

let clientPromise: Promise<Client> | null = null;

const ToolTextResultSchema = z.object({
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string()
    }).passthrough()
  )
});

async function getClient() {
  if (!clientPromise) {
    clientPromise = createClient();
  }
  return clientPromise;
}

async function createClient() {
  const client = new Client({
    name: "anti-erp-command-center",
    version: "0.1.0"
  });
  const transport = new StdioClientTransport({
    command: process.env.MCP_SERVER_COMMAND ?? "pnpm",
    args: (process.env.MCP_SERVER_ARGS ?? "--filter @anti-erp/mcp-server dev").split(" "),
    cwd: process.env.MCP_SERVER_CWD ?? process.cwd(),
    stderr: "pipe"
  });

  await client.connect(transport);
  return client;
}

async function callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args });
  const parsedResult = ToolTextResultSchema.parse(result);
  const text = parsedResult.content[0]?.text;
  if (!text) {
    throw new Error(`MCP tool ${name} did not return text content.`);
  }
  return schema.parse(JSON.parse(text));
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
