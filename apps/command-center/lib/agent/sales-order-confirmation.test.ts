import assert from "node:assert/strict";
import test from "node:test";
import type { SalesOrderPreview } from "@anti-erp/shared";
import { confirmSalesOrder } from "./sales-order-confirmation";
import type { CapabilityGateway } from "../capabilities";

const preview: SalesOrderPreview = {
  customer: {
    id: "cus_test",
    name: "Cliente Teste",
    taxId: "00.000.000/0001-00",
    city: "Sao Paulo",
    status: "active"
  },
  lines: [
    {
      productId: "prd_mouse",
      sku: "MOU-001",
      name: "Mouse",
      quantity: 1,
      unitPrice: 50,
      total: 50
    }
  ],
  subtotal: 50,
  warnings: [],
  confirmationRequired: true
};

test("confirmSalesOrder creates an order without invoice", async () => {
  const calls: string[] = [];
  const gateway = createGatewayStub(calls);

  const response = await confirmSalesOrder(gateway, preview, false);

  assert.equal(response.order?.id, "SO-9001");
  assert.equal(response.invoice, null);
  assert.equal(response.lastOrderId, "SO-9001");
  assert.deepEqual(calls, ["createSalesOrder"]);
});

test("confirmSalesOrder creates order and concept invoice", async () => {
  const calls: string[] = [];
  const gateway = createGatewayStub(calls);

  const response = await confirmSalesOrder(gateway, preview, true);

  assert.equal(response.order?.id, "SO-9001");
  assert.equal(response.invoice?.id, "CI-9001");
  assert.equal(response.invoice?.salesOrderId, "SO-9001");
  assert.deepEqual(calls, ["createSalesOrder", "createConceptInvoice"]);
});

function createGatewayStub(calls: string[]): CapabilityGateway {
  return {
    async createSalesOrder(input) {
      calls.push("createSalesOrder");
      assert.equal(input.confirmedByUser, true);
      return {
        ...input.preview,
        id: "SO-9001",
        status: "confirmed",
        createdAt: "2026-07-08T00:00:00.000Z"
      };
    },
    async createConceptInvoice(input) {
      calls.push("createConceptInvoice");
      return {
        id: "CI-9001",
        salesOrderId: input.salesOrderId,
        customerName: "Cliente Teste",
        amount: 50,
        issuedAt: "2026-07-08T00:00:00.000Z",
        disclaimer: "Concept invoice for tests."
      };
    },
    createCustomer: unsupported,
    createProduct: unsupported,
    createSupplier: unsupported,
    updateProduct: unsupported,
    searchCustomer: unsupported,
    searchProduct: unsupported,
    validateStock: unsupported,
    listLowStockProducts: unsupported,
    prepareSalesOrder: unsupported,
    getSalesOrder: unsupported,
    listRecentOrders: unsupported,
    getTraditionalErpFlow: unsupported,
    querySalesMetrics: unsupported
  };
}

async function unsupported(): Promise<never> {
  throw new Error("Unsupported test gateway method.");
}
