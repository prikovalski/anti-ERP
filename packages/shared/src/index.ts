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

export const SupplierSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "blocked"])
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

export const CreateCustomerInputSchema = z.object({
  name: z.string().trim().min(2)
});

export const CreateProductInputSchema = z.object({
  name: z.string().trim().min(2)
});

export const CreateSupplierInputSchema = z.object({
  name: z.string().trim().min(2)
});

export const UpdateProductInputSchema = z.object({
  productId: z.string(),
  unitPrice: z.number().nonnegative().nullable().optional(),
  availableStock: z.number().int().nonnegative().nullable().optional()
}).refine((input) => input.unitPrice !== undefined || input.availableStock !== undefined, {
  message: "At least one product field must be provided."
});

export const ValidateStockInputSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive()
});

export const ListLowStockProductsInputSchema = z.object({
  threshold: z.number().int().nonnegative().default(10)
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

export const AddSalesOrderLineInputSchema = z.object({
  salesOrderId: z.string(),
  productId: z.string(),
  quantity: z.number().int().positive()
});

export const SetSalesOrderLineQuantityInputSchema = z.object({
  salesOrderId: z.string(),
  productId: z.string(),
  quantity: z.number().int().nonnegative()
});

export const RemoveSalesOrderLineInputSchema = z.object({
  salesOrderId: z.string(),
  productId: z.string()
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

export const QuerySalesMetricsInputSchema = z.object({
  metric: AnalyticsMetricSchema,
  productQuery: z.string().nullable().optional(),
  productQueries: z.array(z.string().min(1)).nullable().optional(),
  customerQuery: z.string().nullable().optional(),
  dateRange: AnalyticsDateRangeSchema,
  groupBy: AnalyticsGroupBySchema.nullable().optional()
});

export const AnalyticsEntitySchema = z.enum(["sales_orders", "sales_order_lines", "customers", "products", "concept_invoices"]);

export const AnalyticsFilterSchema = z.object({
  label: z.string(),
  value: z.string()
});

export const AnalyticsResultSchema = z.object({
  metric: AnalyticsMetricSchema,
  value: z.number(),
  label: z.string(),
  query: z.object({
    capability: z.literal("query_sales_metrics"),
    entities: z.array(AnalyticsEntitySchema),
    filters: z.array(AnalyticsFilterSchema),
    groupBy: AnalyticsGroupBySchema.nullable(),
    dateRange: AnalyticsDateRangeSchema,
    dataSource: z.enum(["demo-memory", "mcp-memory", "postgres"])
  }),
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

export const ConversationEntitySchema = z.object({
  id: z.string().nullable(),
  name: z.string()
});

export const ConversationContextSchema = z.object({
  activeOrderId: z.string().nullable().default(null),
  activeInvoiceId: z.string().nullable().default(null),
  activeCustomer: ConversationEntitySchema.nullable().default(null),
  activeProducts: z.array(ConversationEntitySchema).default([]),
  lastDocumentType: z.enum(["sales_order_preview", "sales_order", "invoice", "report", "catalog", "plan", "message"]).nullable().default(null),
  pendingConfirmation: z.enum(["sales_order", "invoice", "none"]).default("none"),
  lastUserCommand: z.string().nullable().default(null),
  lastAgentSummary: z.string().nullable().default(null)
});

export const ExecutionPlanStepSchema = z.object({
  id: z.string(),
  action: z.enum([
    "create_customer",
    "create_product",
    "create_supplier",
    "prepare_sales_order",
    "create_invoice",
    "query_report"
  ]),
  description: z.string(),
  status: z.enum(["planned", "executed", "pending_confirmation", "blocked", "skipped"]),
  detail: z.string().nullable().optional()
});

export const ExecutionPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(ExecutionPlanStepSchema).min(1)
});

export const ClarificationOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable().optional()
});

export const ClarificationRequestSchema = z.object({
  kind: z.enum(["customer", "product"]),
  query: z.string(),
  question: z.string(),
  options: z.array(ClarificationOptionSchema).min(2)
});

export const AgentRequestSchema = z.object({
  message: z.string().min(1),
  lastOrderId: z.string().optional(),
  conversationContext: ConversationContextSchema.optional()
});

export const AgentConfirmRequestSchema = z.object({
  preview: SalesOrderPreviewSchema,
  createInvoice: z.boolean().default(false),
  conversationContext: ConversationContextSchema.optional()
});

export const AgentResponseSchema = z.object({
  message: AgentMessageSchema,
  preview: SalesOrderPreviewSchema.nullable().optional(),
  order: SalesOrderSchema.nullable().optional(),
  invoice: ConceptInvoiceSchema.nullable().optional(),
  analyticsResult: AnalyticsResultSchema.nullable().optional(),
  executionPlan: ExecutionPlanSchema.nullable().optional(),
  clarification: ClarificationRequestSchema.nullable().optional(),
  auditEvents: z.array(AuditEventSchema),
  mcpTrace: z.array(
    z.object({
      id: z.string(),
      requestId: z.string(),
      role: z.string(),
      tool: z.string(),
      status: z.enum(["success", "error"]),
      durationMs: z.number().int().nonnegative(),
      inputSummary: z.record(z.unknown()).nullable().optional(),
      outputSummary: z.record(z.unknown()).nullable().optional(),
      error: z.string().nullable().optional(),
      timestamp: z.string()
    })
  ).optional(),
  mode: z.enum(["langgraph", "openrouter"]),
  lastOrderId: z.string().nullable().optional(),
  conversationContext: ConversationContextSchema.optional()
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
export type Supplier = z.infer<typeof SupplierSchema>;
export type CreateCustomerInput = z.infer<typeof CreateCustomerInputSchema>;
export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;
export type CreateSupplierInput = z.infer<typeof CreateSupplierInputSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductInputSchema>;
export type ListLowStockProductsInput = z.infer<typeof ListLowStockProductsInputSchema>;
export type AddSalesOrderLineInput = z.infer<typeof AddSalesOrderLineInputSchema>;
export type SetSalesOrderLineQuantityInput = z.infer<typeof SetSalesOrderLineQuantityInputSchema>;
export type RemoveSalesOrderLineInput = z.infer<typeof RemoveSalesOrderLineInputSchema>;
export type SalesOrderLine = z.infer<typeof SalesOrderLineSchema>;
export type SalesOrderPreview = z.infer<typeof SalesOrderPreviewSchema>;
export type SalesOrder = z.infer<typeof SalesOrderSchema>;
export type ConceptInvoice = z.infer<typeof ConceptInvoiceSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AnalyticsMetric = z.infer<typeof AnalyticsMetricSchema>;
export type AnalyticsDateRange = z.infer<typeof AnalyticsDateRangeSchema>;
export type AnalyticsGroupBy = z.infer<typeof AnalyticsGroupBySchema>;
export type QuerySalesMetricsInput = z.infer<typeof QuerySalesMetricsInputSchema>;
export type AnalyticsEntity = z.infer<typeof AnalyticsEntitySchema>;
export type AnalyticsFilter = z.infer<typeof AnalyticsFilterSchema>;
export type AnalyticsResult = z.infer<typeof AnalyticsResultSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type ConversationEntity = z.infer<typeof ConversationEntitySchema>;
export type ConversationContext = z.infer<typeof ConversationContextSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type ExecutionPlanStep = z.infer<typeof ExecutionPlanStepSchema>;
export type ClarificationOption = z.infer<typeof ClarificationOptionSchema>;
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentConfirmRequest = z.infer<typeof AgentConfirmRequestSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
