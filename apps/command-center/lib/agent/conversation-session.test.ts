import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryConversationSessionStore } from "@anti-erp/capabilities";
import type { AgentResponse } from "@anti-erp/shared";
import { POST as agentRoute } from "../../app/api/agent/route";
import { POST as confirmRoute } from "../../app/api/agent/confirm/route";
import { GET as documentDetailRoute } from "../../app/api/document-detail/route";
import { demoCapabilityGateway as gateway } from "../capabilities/demo-gateway";

process.env.CAPABILITY_GATEWAY = "demo";
process.env.LANGSMITH_TRACING = "false";
delete process.env.OPENROUTER_API_KEY;

async function post(route: (request: Request) => Promise<Response>, body: unknown) {
  const response = await route(new Request("http://localhost/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
  return { status: response.status, body: (await response.json()) as AgentResponse & { message: AgentResponse["message"] | string } };
}

// P2.8
test("client-supplied context is ignored; the active order comes from the server session", async () => {
  const forged = await post(agentRoute, {
    message: "cancele o pedido",
    lastOrderId: "SO-1001",
    conversationContext: { activeOrderId: "SO-1001" }
  });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.pendingAction, undefined);
  assert.equal(forged.body.conversationContext?.activeOrderId, null);

  const prepared = await post(agentRoute, { message: "Crie um pedido para Northstar com 1 monitor" });
  const sessionId = prepared.body.sessionId;
  assert.ok(sessionId);
  const confirmed = await post(confirmRoute, { actionId: prepared.body.pendingAction?.id, sessionId });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.sessionId, sessionId);
  const orderId = confirmed.body.order?.id;
  assert.ok(orderId);

  const cancel = await post(agentRoute, { message: "cancele o pedido", sessionId });
  assert.equal(cancel.body.pendingAction?.kind, "sales_order.cancel");
  assert.match(cancel.body.pendingAction?.summary ?? "", new RegExp(orderId));
});

// P2.8
test("opening a document makes it the session's active order", async () => {
  const [customer] = await gateway.searchCustomer({ query: "Globo" });
  const [product] = await gateway.searchProduct({ query: "teclado" });
  assert.ok(customer && product);
  const order = await gateway.createSalesOrder({ customerId: customer.id, lines: [{ productId: product.id, quantity: 1 }], confirmedByUser: true });
  const first = await post(agentRoute, { message: "liste os pedidos" });

  const detail = await documentDetailRoute(new Request(`http://localhost/api/document-detail?type=order&id=${order.id}&sessionId=${first.body.sessionId}`));
  const detailBody = (await detail.json()) as { sessionId: string; conversationContext: { activeOrderId: string } };
  assert.equal(detailBody.sessionId, first.body.sessionId);
  assert.equal(detailBody.conversationContext.activeOrderId, order.id);

  const discount = await post(agentRoute, { message: "aplique 10% de desconto no pedido", sessionId: first.body.sessionId });
  assert.equal(discount.body.pendingAction?.kind, "sales_order.discount");
  assert.match(discount.body.pendingAction?.summary ?? "", new RegExp(order.id));
});

test("unknown or expired session ids start a new empty session", async () => {
  const store = new InMemoryConversationSessionStore();
  const fresh = await store.load("cs_does_not_exist");
  assert.notEqual(fresh.id, "cs_does_not_exist");
  assert.equal(fresh.context.activeOrderId, null);

  await store.save({ ...fresh, context: { ...fresh.context, activeOrderId: "SO-1" } });
  assert.equal((await store.load(fresh.id)).context.activeOrderId, "SO-1");
});

test("invalid agent requests return 400", async () => {
  assert.equal((await post(agentRoute, { message: "" })).status, 400);
  assert.equal((await post(agentRoute, { message: "x".repeat(2001) })).status, 400);
  assert.equal((await post(confirmRoute, { preview: {} })).status, 400);
});
