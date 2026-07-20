import type {
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  AnalyticsResult,
  ConceptInvoice,
  Customer,
  IntelligentReport,
  InventoryMovement,
  ListConceptInvoicesInput,
  ListInventoryMovementsInput,
  ListSalesOrdersInput,
  ManagerialReport,
  Product,
  QueryManagerialReportInput,
  SalesOrder,
  SalesOrderPreview,
  SearchCatalogInput,
  Supplier
} from "@anti-erp/shared";

export interface CapabilityGateway {
  createCustomer(input: { name: string }): Promise<Customer>;
  updateCustomer(input: {
    customerId: string;
    name?: string | null;
    city?: string | null;
    status?: "active" | "inactive" | "blocked" | null;
  }): Promise<Customer>;
  listCustomers(): Promise<Customer[]>;
  createProduct(input: { name: string }): Promise<Product>;
  listProducts(input?: SearchCatalogInput): Promise<Product[]>;
  createSupplier(input: { name: string }): Promise<Supplier>;
  updateSupplier(input: {
    supplierId: string;
    name?: string | null;
    status?: "active" | "inactive" | "blocked" | null;
  }): Promise<Supplier>;
  searchSupplier(input: { query: string }): Promise<Supplier[]>;
  listSuppliers(input?: SearchCatalogInput): Promise<Supplier[]>;
  updateProduct(input: {
    productId: string;
    name?: string | null;
    unitPrice?: number | null;
    availableStock?: number | null;
    status?: "active" | "inactive" | null;
  }): Promise<Product>;
  searchCustomer(input: { query: string }): Promise<Customer[]>;
  searchCustomersAdvanced(input?: SearchCatalogInput): Promise<Customer[]>;
  searchProduct(input: { query: string }): Promise<Product[]>;
  searchProductsAdvanced(input?: SearchCatalogInput): Promise<Product[]>;
  validateStock(input: { productId: string; quantity: number }): Promise<{
    productId: string;
    requested: number;
    available: number;
    valid: boolean;
  }>;
  listLowStockProducts(input?: { threshold?: number }): Promise<Product[]>;
  createInventoryEntry(input: { productId: string; quantity: number; reason?: string | null }): Promise<InventoryMovement>;
  createInventoryExit(input: { productId: string; quantity: number; reason?: string | null }): Promise<InventoryMovement>;
  adjustInventory(input: { productId: string; quantity: number; reason?: string | null }): Promise<InventoryMovement>;
  reserveInventory(input: {
    productId: string;
    quantity: number;
    salesOrderId?: string | null;
    reason?: string | null;
  }): Promise<InventoryMovement>;
  releaseInventoryReservation(input: {
    productId: string;
    quantity: number;
    salesOrderId?: string | null;
    reason?: string | null;
  }): Promise<InventoryMovement>;
  writeOffInventoryForSalesOrder(input: { salesOrderId: string; reason?: string | null }): Promise<InventoryMovement[]>;
  listInventoryMovements(input?: ListInventoryMovementsInput): Promise<InventoryMovement[]>;
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
  applySalesOrderDiscount(input: {
    salesOrderId: string;
    productId?: string | null;
    discountType: "percent" | "amount";
    value: number;
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
  queryManagerialReport(input: QueryManagerialReportInput): Promise<ManagerialReport>;
  queryIntelligentReport(input: { question: string }): Promise<IntelligentReport>;
}
