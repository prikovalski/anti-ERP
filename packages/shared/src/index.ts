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

export type Customer = z.infer<typeof CustomerSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type SalesOrderPreview = z.infer<typeof SalesOrderPreviewSchema>;
export type SalesOrder = z.infer<typeof SalesOrderSchema>;
export type ConceptInvoice = z.infer<typeof ConceptInvoiceSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
