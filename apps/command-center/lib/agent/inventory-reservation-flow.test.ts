import assert from "node:assert/strict";
import test from "node:test";
import { DemoCapabilityGateway } from "../capabilities/demo-gateway";

test("sales order confirmation reserves stock and invoice writeoff consumes reservation", async () => {
  const gateway = new DemoCapabilityGateway();
  const [customer] = await gateway.searchCustomer({ query: "Northstar" });
  const [product] = await gateway.searchProduct({ query: "monitor" });
  assert.ok(customer);
  assert.ok(product);

  const startingAvailable = product.availableStock;
  const startingReserved = product.reservedStock ?? 0;
  const preview = await gateway.prepareSalesOrder({
    customerId: customer.id,
    lines: [{ productId: product.id, quantity: 2 }]
  });
  const order = await gateway.createSalesOrder({
    preview,
    confirmedByUser: true
  });
  const [afterOrder] = await gateway.searchProduct({ query: "monitor" });

  assert.equal(afterOrder?.availableStock, startingAvailable - 2);
  assert.equal(afterOrder?.reservedStock, startingReserved + 2);

  await gateway.createConceptInvoice({ salesOrderId: order.id });
  const [afterInvoice] = await gateway.searchProduct({ query: "monitor" });

  assert.equal(afterInvoice?.availableStock, startingAvailable - 2);
  assert.equal(afterInvoice?.reservedStock, startingReserved);

  await gateway.createConceptInvoice({ salesOrderId: order.id });
  const [afterSecondInvoice] = await gateway.searchProduct({ query: "monitor" });

  assert.equal(afterSecondInvoice?.availableStock, startingAvailable - 2);
  assert.equal(afterSecondInvoice?.reservedStock, startingReserved);
});
