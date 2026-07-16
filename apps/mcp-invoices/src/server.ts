import { PrismaCapabilityGateway } from "@anti-erp/capabilities";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "anti-erp-invoices-mcp",
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

server.tool("create_concept_invoice", { salesOrderId: z.string() }, async (input) =>
  json(await gateway.createConceptInvoice(input))
);

server.tool("cancel_concept_invoice", { invoiceId: z.string() }, async (input) =>
  json(await gateway.cancelConceptInvoice(input))
);

server.tool("reissue_concept_invoice", { invoiceId: z.string() }, async (input) =>
  json(await gateway.reissueConceptInvoice(input))
);

server.tool("get_concept_invoice", { invoiceId: z.string() }, async (input) =>
  json(await gateway.getConceptInvoice(input))
);

server.tool(
  "list_concept_invoices",
  {
    salesOrderId: z.string().nullable().optional(),
    dateRange: z.enum(["today", "last_7_days", "month_to_date", "all_time"]).nullable().optional(),
    status: z.enum(["issued", "canceled", "reissued"]).nullable().optional(),
    take: z.number().int().positive().max(100).nullable().optional()
  },
  async (input) => json(await gateway.listConceptInvoices(input))
);

const transport = new StdioServerTransport();
await server.connect(transport);
