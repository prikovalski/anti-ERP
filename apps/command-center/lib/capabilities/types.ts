import type {
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  AnalyticsResult,
  ConceptInvoice,
  Customer,
  ListConceptInvoicesInput,
  ListSalesOrdersInput,
  Product,
  SalesOrder,
  SalesOrderPreview,
  Supplier
} from "@anti-erp/shared";

export interface CapabilityGateway {
  createCustomer(input: { name: string }): Promise<Customer>;
  listCustomers(): Promise<Customer[]>;
  createProduct(input: { name: string }): Promise<Product>;
  createSupplier(input: { name: string }): Promise<Supplier>;
  updateProduct(input: {
    productId: string;
    unitPrice?: number | null;
    availableStock?: number | null;
  }): Promise<Product>;
  searchCustomer(input: { query: string }): Promise<Customer[]>;
  searchProduct(input: { query: string }): Promise<Product[]>;
  validateStock(input: { productId: string; quantity: number }): Promise<{
    productId: string;
    requested: number;
    available: number;
    valid: boolean;
  }>;
  listLowStockProducts(input?: { threshold?: number }): Promise<Product[]>;
  prepareSalesOrder(input: {
    customerId: string;
    lines: Array<{ productId: string; quantity: number }>;
  }): Promise<SalesOrderPreview>;
  createSalesOrder(input: {
    preview: SalesOrderPreview;
    confirmedByUser: true;
  }): Promise<SalesOrder>;
  addSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }): Promise<SalesOrder>;
  setSalesOrderLineQuantity(input: {
    salesOrderId: string;
    productId: string;
    quantity: number;
  }): Promise<SalesOrder>;
  removeSalesOrderLine(input: {
    salesOrderId: string;
    productId: string;
  }): Promise<SalesOrder>;
  cancelSalesOrder(input: { salesOrderId: string }): Promise<SalesOrder>;
  duplicateSalesOrder(input: { salesOrderId: string }): Promise<SalesOrder>;
  createConceptInvoice(input: { salesOrderId: string }): Promise<ConceptInvoice>;
  cancelConceptInvoice(input: { invoiceId: string }): Promise<ConceptInvoice>;
  reissueConceptInvoice(input: { invoiceId: string }): Promise<ConceptInvoice>;
  getConceptInvoice(input: { invoiceId: string }): Promise<ConceptInvoice | null>;
  listConceptInvoices(input?: ListConceptInvoicesInput): Promise<ConceptInvoice[]>;
  getSalesOrder(input: { salesOrderId: string }): Promise<SalesOrder | null>;
  listSalesOrders(input?: ListSalesOrdersInput): Promise<SalesOrder[]>;
  listRecentOrders(): Promise<SalesOrder[]>;
  getTraditionalErpFlow(): Promise<{
    traditional: string[];
    antiErp: string[];
  }>;
  querySalesMetrics(input: {
    metric: AnalyticsMetric;
    productQuery?: string | null;
    productQueries?: string[] | null;
    customerQuery?: string | null;
    dateRange: AnalyticsDateRange;
    groupBy?: AnalyticsGroupBy | null;
  }): Promise<AnalyticsResult>;
}
