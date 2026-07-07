import type {
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  AnalyticsResult,
  ConceptInvoice,
  Customer,
  Product,
  SalesOrder,
  SalesOrderPreview
} from "@anti-erp/shared";

export interface CapabilityGateway {
  searchCustomer(input: { query: string }): Promise<Customer[]>;
  searchProduct(input: { query: string }): Promise<Product[]>;
  validateStock(input: { productId: string; quantity: number }): Promise<{
    productId: string;
    requested: number;
    available: number;
    valid: boolean;
  }>;
  prepareSalesOrder(input: {
    customerId: string;
    lines: Array<{ productId: string; quantity: number }>;
  }): Promise<SalesOrderPreview>;
  createSalesOrder(input: {
    preview: SalesOrderPreview;
    confirmedByUser: true;
  }): Promise<SalesOrder>;
  createConceptInvoice(input: { salesOrderId: string }): Promise<ConceptInvoice>;
  getSalesOrder(input: { salesOrderId: string }): Promise<SalesOrder | null>;
  listRecentOrders(): Promise<SalesOrder[]>;
  getTraditionalErpFlow(): Promise<{
    traditional: string[];
    antiErp: string[];
  }>;
  querySalesMetrics(input: {
    metric: AnalyticsMetric;
    productQuery?: string | null;
    customerQuery?: string | null;
    dateRange: AnalyticsDateRange;
    groupBy?: AnalyticsGroupBy | null;
  }): Promise<AnalyticsResult>;
}
