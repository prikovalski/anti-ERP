import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResponse } from "@anti-erp/shared";
import { getPendingActionStore } from "../capabilities";
import { demoCapabilityGateway as gateway } from "../capabilities/demo-gateway";
import { runAgent } from "./agent";
import { antiErpAgentGraph } from "./agent-graph";
import { confirmPendingAction } from "./pending-actions";

process.env.CAPABILITY_GATEWAY = "demo";
process.env.LANGSMITH_TRACING = "false";
delete process.env.OPENROUTER_API_KEY;

function suffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function confirm(response: AgentResponse, createInvoice?: boolean) {
  assert.ok(response.pendingAction, `expected a pending confirmation, got: ${response.message.text}`);
  const { response: confirmed } = await confirmPendingAction({
    actionId: response.pendingAction.id,
    createInvoice,
    gateway,
    store: await getPendingActionStore()
  });
  return confirmed;
}

async function existingOrder() {
  const [customer] = await gateway.searchCustomer({ query: "Globo" });
  const [product] = await gateway.searchProduct({ query: "teclado" });
  assert.ok(customer && product);
  return gateway.createSalesOrder({ customerId: customer.id, lines: [{ productId: product.id, quantity: 1 }], confirmedByUser: true });
}

// P2.3: the README's flagship command used to issue an invoice for the previous order.
test("order with invoice creates a new order proposal even when another order is active", async () => {
  const previous = await existingOrder();

  const response = await runAgent({ message: "Crie um pedido para Northstar com 2 notebooks e gere a nota.", lastOrderId: previous.id });

  assert.equal(response.preview?.customer.name, "Northstar Labs");
  assert.equal(response.pendingAction?.kind, "sales_order.create");
  assert.equal(response.pendingAction?.createInvoice, true);
  assert.equal(response.invoice, undefined);
  assert.equal((await gateway.listConceptInvoices({ salesOrderId: previous.id })).length, 0);

  const confirmed = await confirm(response);
  assert.ok(confirmed.order && confirmed.order.id !== previous.id);
  assert.equal(confirmed.invoice?.salesOrderId, confirmed.order.id);
});

// P2.3
test("order with a reservation request is prepared and explains when stock is reserved", async () => {
  const response = await runAgent({ message: "Crie um pedido para Northstar com 3 notebooks e reserve o estoque" });

  assert.deepEqual(response.preview?.lines.map((line) => [line.name, line.quantity]), [["Notebook Air 14", 3]]);
  assert.match(response.pendingAction?.details.join(" ") ?? "", /reservado automaticamente/);
});

// P2.6
test("invoice choice comes from the message and the user can still override it", async () => {
  const withoutInvoice = await runAgent({ message: "Crie um pedido para Northstar com 1 monitor sem nota fiscal" });
  assert.equal(withoutInvoice.pendingAction?.createInvoice, false);
  assert.equal((await confirm(withoutInvoice)).invoice, null);

  const overridden = await runAgent({ message: "Crie um pedido para Northstar com 1 monitor sem nota fiscal" });
  assert.equal((await confirm(overridden, true)).invoice?.status, "issued");
});

// P2.7
test("cancellation message reports what happened to stock and invoices", async () => {
  const reserved = await existingOrder();
  const reservedCancel = await confirm(await runAgent({ message: `cancele o pedido ${reserved.id}` }));
  assert.match(reservedCancel.message.text, /reserva de 1 unidade\(s\) foi liberada/);

  const invoiced = await existingOrder();
  const invoice = await gateway.createConceptInvoice({ salesOrderId: invoiced.id });
  const invoicedCancel = await confirm(await runAgent({ message: `cancele o pedido ${invoiced.id}` }));
  assert.match(invoicedCancel.message.text, /ja tinha sido baixado/);
  assert.match(invoicedCancel.message.text, new RegExp(`${invoice.id} continua emitida`));
  assert.doesNotMatch(invoicedCancel.message.text, /recomposto/);
});

// P2.7
test("messages use the stored record and Portuguese metric labels", async () => {
  const created = await runAgent({ message: `cadastre o produto   Cabo   Teste ${suffix()}` });
  assert.match(created.message.text, /^Cabo Teste \w+ cadastrado com sucesso\.$/);

  const metrics = await runAgent({ message: "quantos notebooks vendemos hoje?" });
  assert.match(metrics.message.text, /^Unidades vendidas de notebook \(hoje\): \d+\.$/);
});

test("multi-step request runs catalog steps and stops the order at confirmation", async () => {
  const name = `Acme ${suffix()}`;
  const response = await runAgent({ message: `cadastre o cliente ${name} e crie um pedido para ${name} com 2 monitores` });

  assert.deepEqual(response.executionPlan?.steps.map((step) => [step.action, step.status]), [
    ["create_customer", "executed"],
    ["prepare_sales_order", "pending_confirmation"]
  ]);
  assert.equal(response.pendingAction?.kind, "sales_order.create");
  assert.equal(response.preview?.customer.name, name);
});

test("traditional ERP comparison has its own answer", async () => {
  const response = await runAgent({ message: "compare o erp tradicional com o anti-erp" });
  assert.match(response.message.text, /^ERP tradicional \(\d+ passos\)/);
});

// P2.2
test("mode reports how the message was understood", async (t) => {
  assert.equal((await runAgent({ message: "liste os produtos" })).mode, "deterministic");

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
  });
  process.env.OPENROUTER_API_KEY = "test-key";

  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  assert.equal((await runAgent({ message: "faz um pedido" })).mode, "fallback");

  globalThis.fetch = async () => Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          intent: "sales_order.create",
          confidence: 0.9,
          entities: { customer: { name: "Northstar" }, items: [{ product: "monitor", quantity: 1 }], wantsInvoice: false }
        })
      }
    }]
  });
  const llm = await runAgent({ message: "manda um monitor pra turma da Northstar" });
  assert.equal(llm.mode, "llm");
  assert.equal(llm.preview?.customer.name, "Northstar Labs");
});

// P2.1
test("Studio graph runs the production classifier and handlers", async () => {
  const state = await antiErpAgentGraph.invoke({ message: "Crie um pedido para Northstar com 1 monitor" });

  assert.equal(state.classification?.command.kind, "order.create");
  assert.equal(state.response?.pendingAction?.kind, "sales_order.create");
  assert.equal(state.response?.mode, "deterministic");
});
