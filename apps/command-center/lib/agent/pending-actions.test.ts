import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPendingActionStore, PendingActionError } from "@anti-erp/capabilities";
import { AgentConfirmRequestSchema, type AgentResponse } from "@anti-erp/shared";
import { getPendingActionStore } from "../capabilities";
import { demoCapabilityGateway as gateway } from "../capabilities/demo-gateway";
import { runAgent } from "./agent";
import { ConfirmationBlockedError, confirmPendingAction } from "./pending-actions";

process.env.CAPABILITY_GATEWAY = "demo";
process.env.LANGSMITH_TRACING = "false";

function suffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function confirm(response: AgentResponse, createInvoice = false) {
  assert.ok(response.pendingAction, `expected a pending confirmation, got: ${response.message.text}`);
  return confirmPendingAction({
    actionId: response.pendingAction.id,
    createInvoice,
    gateway,
    store: await getPendingActionStore()
  });
}

async function createStockedProduct(unitPrice: number, availableStock: number) {
  const product = await gateway.createProduct({ name: `Cadeira Teste ${suffix()}` });
  return gateway.updateProduct({ productId: product.id, unitPrice, availableStock });
}

async function prepareOrder(customerName: string, productName: string, quantity: number) {
  return runAgent({ message: `Crie um pedido para ${customerName} com ${quantity} ${productName}` });
}

// P0.1
test("confirmation request carries only an action id, never a preview", () => {
  const tampered = AgentConfirmRequestSchema.safeParse({
    preview: { customer: { id: "cus_northstar" }, lines: [{ productId: "prd_notebook", unitPrice: 0.01 }] }
  });
  assert.equal(tampered.success, false);
});

// P0.1
test("confirmed order uses catalog prices", async () => {
  const product = await createStockedProduct(6200, 20);
  const customer = await gateway.createCustomer({ name: `Cliente Preco ${suffix()}` });

  const proposal = await prepareOrder(customer.name, product.name, 1);
  assert.equal(proposal.pendingAction?.kind, "sales_order.create");

  const { response } = await confirm(proposal);
  assert.equal(response.order?.lines[0]?.unitPrice, 6200);
  assert.equal(response.order?.subtotal, 6200);
});

// P0.1
test("price change between preview and confirmation blocks the order", async () => {
  const product = await createStockedProduct(100, 20);
  const customer = await gateway.createCustomer({ name: `Cliente Reajuste ${suffix()}` });
  const proposal = await prepareOrder(customer.name, product.name, 2);

  await gateway.updateProduct({ productId: product.id, unitPrice: 150 });

  await assert.rejects(confirm(proposal), ConfirmationBlockedError);
  const [after] = await gateway.searchProduct({ query: product.name });
  assert.equal(after?.reservedStock, 0);
});

// P0.2
test("customer blocked after the preview cannot receive the order", async () => {
  const product = await createStockedProduct(100, 20);
  const customer = await gateway.createCustomer({ name: `Cliente Bloqueio ${suffix()}` });
  const proposal = await prepareOrder(customer.name, product.name, 1);

  await gateway.updateCustomer({ customerId: customer.id, status: "blocked" });

  await assert.rejects(confirm(proposal), (error) => {
    assert.ok(error instanceof ConfirmationBlockedError);
    assert.match(error.message, /blocked/i);
    return true;
  });
  await assert.rejects(
    gateway.createSalesOrder({ customerId: customer.id, lines: [{ productId: product.id, quantity: 1 }], confirmedByUser: true }),
    /blocked/i
  );
});

// P0.3
test("concurrent confirmations of the same action create one order", async () => {
  const product = await createStockedProduct(100, 20);
  const customer = await gateway.createCustomer({ name: `Cliente Duplo ${suffix()}` });
  const proposal = await prepareOrder(customer.name, product.name, 3);

  const results = await Promise.allSettled([confirm(proposal), confirm(proposal)]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof PendingActionError);
  assert.equal(rejected[0]!.reason.code, "already_used");
  const [after] = await gateway.searchProduct({ query: product.name });
  assert.equal(after?.reservedStock, 3);
  assert.equal(after?.availableStock, 17);
});

// P0.3
test("expired action cannot be confirmed", async () => {
  const store = new InMemoryPendingActionStore();
  const record = await store.create({
    payload: { kind: "sales_order.cancel", salesOrderId: "SO-0" },
    summary: "Cancelar pedido de teste.",
    ttlMs: 0
  });

  await assert.rejects(
    confirmPendingAction({ actionId: record.id, createInvoice: false, gateway, store }),
    (error) => error instanceof PendingActionError && error.code === "expired"
  );
});

// P0.5
test("ambiguous customer in a destructive command returns a question and writes nothing", async () => {
  const before = (await gateway.listCustomers()).map((customer) => [customer.id, customer.status]);

  const response = await runAgent({ message: "inative o cliente la" });

  assert.equal(response.pendingAction, undefined);
  assert.equal(response.clarification?.kind, "customer");
  assert.ok((response.clarification?.options.length ?? 0) >= 2);
  assert.match(response.message.text, /Qual deles/);
  assert.deepEqual((await gateway.listCustomers()).map((customer) => [customer.id, customer.status]), before);
});

// P0.6
test("destructive and sensitive commands only write after confirmation", async () => {
  const product = await createStockedProduct(80, 30);
  const customer = await gateway.createCustomer({ name: `Cliente Destrutivo ${suffix()}` });
  const order = await gateway.createSalesOrder({
    customerId: customer.id,
    lines: [{ productId: product.id, quantity: 2 }],
    confirmedByUser: true
  });
  const invoice = await gateway.createConceptInvoice({ salesOrderId: order.id });
  const renamed = `Cliente Renomeado ${suffix()}`;

  const proposals = {
    cancelOrder: await runAgent({ message: `cancele o pedido ${order.id}` }),
    duplicateOrder: await runAgent({ message: `duplique o pedido ${order.id}` }),
    discount: await runAgent({ message: `aplique 10% de desconto no pedido ${order.id}` }),
    cancelInvoice: await runAgent({ message: `cancele a nota fiscal ${invoice.id}` }),
    reissueInvoice: await runAgent({ message: `reemita a nota fiscal ${invoice.id}` }),
    price: await runAgent({ message: `Atualize o preço do produto ${product.name} para 50 reais` }),
    adjust: await runAgent({ message: `ajuste o estoque do produto ${product.name} para 3 unidades` }),
    deactivate: await runAgent({ message: `inative o produto ${product.name}` }),
    rename: await runAgent({ message: `renomeie o cliente ${customer.name} para ${renamed}` })
  };

  assert.deepEqual(
    Object.fromEntries(Object.entries(proposals).map(([name, response]) => [name, response.pendingAction?.kind ?? response.message.text])),
    {
      cancelOrder: "sales_order.cancel",
      duplicateOrder: "sales_order.duplicate",
      discount: "sales_order.discount",
      cancelInvoice: "invoice.cancel",
      reissueInvoice: "invoice.reissue",
      price: "product.update",
      adjust: "inventory.adjust",
      deactivate: "product.update",
      rename: "customer.update"
    }
  );

  const [productAfterProposals] = await gateway.searchProduct({ query: product.name });
  assert.equal((await gateway.getSalesOrder({ salesOrderId: order.id }))?.status, "confirmed");
  assert.equal((await gateway.getSalesOrder({ salesOrderId: order.id }))?.subtotal, 160);
  assert.equal((await gateway.getConceptInvoice({ invoiceId: invoice.id }))?.status, "issued");
  assert.equal(productAfterProposals?.unitPrice, 80);
  assert.equal(productAfterProposals?.status, "active");
  assert.equal((await gateway.searchCustomer({ query: customer.name }))[0]?.name, customer.name);
  assert.equal((await gateway.listSalesOrders({ customerQuery: customer.name })).length, 1);

  await confirm(proposals.price);
  await confirm(proposals.cancelOrder);
  const [productAfterConfirmation] = await gateway.searchProduct({ query: product.name });
  assert.equal(productAfterConfirmation?.unitPrice, 50);
  assert.equal((await gateway.getSalesOrder({ salesOrderId: order.id }))?.status, "canceled");
});
