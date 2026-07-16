import { PrismaCapabilityGateway } from "@anti-erp/capabilities";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "anti-erp-products-mcp",
  version: "0.1.0"
});
const gateway = new PrismaCapabilityGateway();

function json(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.tool("search_product", { query: z.string().min(2) }, async (input) =>
  json(await gateway.searchProduct(input))
);

server.tool(
  "search_products_advanced",
  {
    query: z.string().trim().min(1).nullable().optional(),
    status: z.enum(["active", "inactive", "blocked"]).nullable().optional(),
    take: z.number().int().positive().max(100).nullable().optional()
  },
  async (input) => json(await gateway.searchProductsAdvanced(input))
);

server.tool("create_product", { name: z.string().trim().min(2) }, async (input) =>
  json(await gateway.createProduct(input))
);

server.tool(
  "list_products",
  {
    query: z.string().trim().min(1).nullable().optional(),
    status: z.enum(["active", "inactive", "blocked"]).nullable().optional(),
    take: z.number().int().positive().max(100).nullable().optional()
  },
  async (input) => json(await gateway.listProducts(input))
);

server.tool(
  "update_product",
  {
    productId: z.string(),
    name: z.string().trim().min(2).nullable().optional(),
    unitPrice: z.number().nonnegative().nullable().optional(),
    availableStock: z.number().int().nonnegative().nullable().optional(),
    status: z.enum(["active", "inactive"]).nullable().optional()
  },
  async (input) => json(await gateway.updateProduct(input))
);

server.tool(
  "validate_stock",
  {
    productId: z.string(),
    quantity: z.number().int().positive()
  },
  async (input) => json(await gateway.validateStock(input))
);

server.tool(
  "list_low_stock_products",
  {
    threshold: z.number().int().nonnegative().optional()
  },
  async (input) => json(await gateway.listLowStockProducts(input))
);

const transport = new StdioServerTransport();
await server.connect(transport);
