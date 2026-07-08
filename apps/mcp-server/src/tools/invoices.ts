import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

export function registerInvoiceTools(server: McpServer, gateway: CapabilityGateway) {
  server.tool("create_concept_invoice", { salesOrderId: z.string() }, async (input) =>
    json(await gateway.createConceptInvoice(input))
  );
}
