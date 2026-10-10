import type {
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  InventoryMovementType,
  ListConceptInvoicesInput,
  ListSalesOrdersInput
} from "@anti-erp/shared";

export type CatalogEntity = "customer" | "product" | "supplier";
export type CatalogStatus = "active" | "inactive" | "blocked";
export type OrderLineRequest = { productQuery: string; quantity: number };
export type InventoryMoveAction = "entry" | "exit" | "adjustment" | "reservation" | "reservation_release";

export type WorkflowStep =
  | { type: "create_customer"; name: string }
  | { type: "create_product"; name: string }
  | { type: "create_supplier"; name: string }
  | { type: "prepare_sales_order"; customerQuery: string | null; lines: OrderLineRequest[]; wantsInvoice: boolean }
  | { type: "create_invoice" }
  | { type: "query_report"; question: string };

/** Everything the agent can do, as one value produced once per message by the classifier. */
export type Command =
  | { kind: "catalog.create"; entity: CatalogEntity; name: string }
  | { kind: "catalog.list"; entity: CatalogEntity; query: string | null; status: CatalogStatus | null }
  | { kind: "catalog.set_status"; entity: CatalogEntity; query: string; status: CatalogStatus }
  | { kind: "catalog.rename"; entity: CatalogEntity; query: string; nextName: string }
  | { kind: "product.update_price"; productQuery: string; unitPrice: number }
  | { kind: "inventory.low_stock"; threshold: number | null }
  | {
      kind: "inventory.history";
      productQuery: string | null;
      salesOrderId: string | null;
      type: InventoryMovementType | null;
      dateRange: AnalyticsDateRange;
    }
  | { kind: "inventory.position"; productQuery: string | null }
  | { kind: "inventory.writeoff"; salesOrderId: string | null }
  | {
      kind: "inventory.move";
      action: InventoryMoveAction;
      productQuery: string | null;
      quantity: number | null;
      salesOrderId: string | null;
    }
  | { kind: "invoice.create"; salesOrderId: string | null }
  | { kind: "invoice.get" | "invoice.cancel" | "invoice.reissue"; invoiceId: string | null }
  | { kind: "invoice.list"; filters: ListConceptInvoicesInput }
  | {
      kind: "order.create";
      customerQuery: string | null;
      lines: OrderLineRequest[];
      wantsInvoice: boolean;
      mentionsReservation: boolean;
    }
  | { kind: "order.get" | "order.cancel" | "order.duplicate"; salesOrderId: string | null }
  | { kind: "order.list"; filters: ListSalesOrdersInput }
  | {
      kind: "order.add_item" | "order.set_item_quantity" | "order.remove_item";
      productQuery: string;
      quantity: number;
      salesOrderId: string | null;
    }
  | {
      kind: "order.discount";
      salesOrderId: string | null;
      productQuery: string | null;
      discountType: "percent" | "amount";
      value: number;
    }
  | { kind: "report.intelligent"; question: string }
  | {
      kind: "report.metrics";
      metric: AnalyticsMetric;
      productQuery: string | null;
      productQueries: string[] | null;
      customerQuery: string | null;
      dateRange: AnalyticsDateRange;
      groupBy: AnalyticsGroupBy | null;
    }
  | { kind: "report.clarify" }
  | { kind: "info.traditional_flow" }
  | { kind: "workflow"; steps: WorkflowStep[] }
  | { kind: "unknown" };

export type CommandKind = Command["kind"];
/** Members whose kind overlaps K; members like order.add_item | order.remove_item share one shape. */
export type CommandOf<K extends CommandKind> = Command extends infer C
  ? C extends { kind: infer CK }
    ? [Extract<CK, K>] extends [never] ? never : C
    : never
  : never;

export type ClassificationSource = "rules" | "llm" | "fallback";

export type Classification = {
  command: Command;
  confidence: number;
  /** rules: deterministic parser; llm: the model's plan was used; fallback: the model was asked and failed. */
  source: ClassificationSource;
  candidates: Array<{ kind: CommandKind; score: number }>;
};
