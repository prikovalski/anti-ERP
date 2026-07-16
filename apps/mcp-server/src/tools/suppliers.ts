import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

export function registerSupplierTools(server: McpServer, gateway: CapabilityGateway) {
  server.tool("create_supplier", { name: z.string().trim().min(2) }, async (input) =>
    json(await gateway.createSupplier(input))
  );

  server.tool(
    "update_supplier",
    {
      supplierId: z.string(),
      name: z.string().trim().min(2).nullable().optional(),
      status: z.enum(["active", "inactive", "blocked"]).nullable().optional()
    },
    async (input) => json(await gateway.updateSupplier(input))
  );

  server.tool("search_supplier", { query: z.string().min(1) }, async (input) =>
    json(await gateway.searchSupplier(input))
  );

  server.tool(
    "list_suppliers",
    {
      query: z.string().trim().min(1).nullable().optional(),
      status: z.enum(["active", "inactive", "blocked"]).nullable().optional(),
      take: z.number().int().positive().max(100).nullable().optional()
    },
    async (input) => json(await gateway.listSuppliers(input))
  );
}
