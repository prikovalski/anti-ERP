import { z } from "zod";

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  taxId: z.string(),
  city: z.string(),
  status: z.enum(["active", "blocked"])
});

export const ProductSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  unitPrice: z.number().nonnegative(),
  availableStock: z.number().int().nonnegative()
});

export const SalesOrderLineSchema = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  total: z.number().nonnegative()
});

export const SalesOrderPreviewSchema = z.object({
  customer: CustomerSchema,
  lines: z.array(SalesOrderLineSchema).min(1),
  subtotal: z.number().nonnegative(),
  warnings: z.array(z.string()),
  confirmationRequired: z.literal(true)
});

export const SalesOrderSchema = SalesOrderPreviewSchema.extend({
  id: z.string(),
  status: z.enum(["draft", "confirmed"]),
  createdAt: z.string()
});

export const ConceptInvoiceSchema = z.object({
  id: z.string(),
  salesOrderId: z.string(),
  customerName: z.string(),
  amount: z.number().nonnegative(),
  issuedAt: z.string(),
  disclaimer: z.string()
});

export const AuditEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  actor: z.enum(["user", "agent", "mcp-tool", "system"]),
  action: z.string(),
  summary: z.string(),
  metadata: z.record(z.unknown()).optional()
});

export const SearchCustomerInputSchema = z.object({
  query: z.string().min(2)
});

export const SearchProductInputSchema = z.object({
  query: z.string().min(2)
});

export const ValidateStockInputSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive()
});

export const PrepareSalesOrderInputSchema = z.object({
  customerId: z.string(),
  lines: z.array(
    z.object({
      productId: z.string(),
      quantity: z.number().int().positive()
    })
  ).min(1)
});

export const CreateSalesOrderInputSchema = z.object({
  preview: SalesOrderPreviewSchema,
  confirmedByUser: z.literal(true)
});

export const CreateConceptInvoiceInputSchema = z.object({
  salesOrderId: z.string()
});

export const GetSalesOrderInputSchema = z.object({
  salesOrderId: z.string()
});

export const AnalyticsMetricSchema = z.enum(["units_sold", "revenue", "order_count"]);

export const AnalyticsDateRangeSchema = z.enum(["today", "last_7_days", "month_to_date", "all_time"]);

export const AnalyticsGroupBySchema = z.enum(["product", "customer", "day"]);

export const AnalyticsResultSchema = z.object({
  metric: AnalyticsMetricSchema,
  value: z.number(),
  label: z.string(),
  rows: z.array(
    z.object({
      label: z.string(),
      value: z.number()
    })
  )
});

export const AgentMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "agent"]),
  text: z.string()
});

export const AgentRequestSchema = z.object({
  message: z.string().min(1),
  lastOrderId: z.string().optional()
});

export const AgentConfirmRequestSchema = z.object({
  preview: SalesOrderPreviewSchema,
  createInvoice: z.boolean().default(false)
});

export const AgentResponseSchema = z.object({
  message: AgentMessageSchema,
  preview: SalesOrderPreviewSchema.nullable().optional(),
  order: SalesOrderSchema.nullable().optional(),
  invoice: ConceptInvoiceSchema.nullable().optional(),
  analyticsResult: AnalyticsResultSchema.nullable().optional(),
  auditEvents: z.array(AuditEventSchema),
  mode: z.enum(["demo-agent", "openrouter", "fallback"]),
  lastOrderId: z.string().nullable().optional()
});

export const demoCustomers: Customer[] = [
  {
    id: "cus_northstar",
    name: "Northstar Labs",
    taxId: "12.345.678/0001-90",
    city: "Sao Paulo",
    status: "active"
  },
  {
    id: "cus_globo",
    name: "Globo Retail Labs",
    taxId: "98.765.432/0001-10",
    city: "Rio de Janeiro",
    status: "active"
  },
  {
    id: "cus_legacy",
    name: "Legacy Parts Ltda",
    taxId: "11.222.333/0001-44",
    city: "Curitiba",
    status: "blocked"
  }
];

export const demoProducts: Product[] = [
  {
    id: "prd_notebook_air",
    sku: "NB-AIR-14",
    name: "Notebook Air 14",
    unitPrice: 6200,
    availableStock: 37
  },
  {
    id: "prd_monitor_27",
    sku: "MON-27-4K",
    name: "Monitor 27 4K",
    unitPrice: 1950,
    availableStock: 18
  },
  {
    id: "prd_keyboard_pro",
    sku: "KEY-PRO-BR",
    name: "Teclado Pro ABNT2",
    unitPrice: 480,
    availableStock: 52
  }
];

export type Customer = z.infer<typeof CustomerSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type SalesOrderLine = z.infer<typeof SalesOrderLineSchema>;
export type SalesOrderPreview = z.infer<typeof SalesOrderPreviewSchema>;
export type SalesOrder = z.infer<typeof SalesOrderSchema>;
export type ConceptInvoice = z.infer<typeof ConceptInvoiceSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AnalyticsMetric = z.infer<typeof AnalyticsMetricSchema>;
export type AnalyticsDateRange = z.infer<typeof AnalyticsDateRangeSchema>;
export type AnalyticsGroupBy = z.infer<typeof AnalyticsGroupBySchema>;
export type AnalyticsResult = z.infer<typeof AnalyticsResultSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentConfirmRequest = z.infer<typeof AgentConfirmRequestSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
