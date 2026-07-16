import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

export function registerProductTools(server: McpServer, gateway: CapabilityGateway) {
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
}
