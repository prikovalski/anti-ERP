import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResponse } from "@anti-erp/shared";
import { runAgent } from "./agent";
import { confirmPendingAction } from "./pending-actions";
import { getPendingActionStore } from "../capabilities";
import { demoCapabilityGateway } from "../capabilities/demo-gateway";

process.env.CAPABILITY_GATEWAY = "demo";
process.env.LANGSMITH_TRACING = "false";

async function confirm(response: AgentResponse) {
  assert.ok(response.pendingAction, `expected a pending confirmation, got: ${response.message.text}`);
  const { response: confirmed } = await confirmPendingAction({
    actionId: response.pendingAction.id,
    createInvoice: false,
    gateway: demoCapabilityGateway,
    store: await getPendingActionStore()
  });
  return confirmed;
}

test("agent executes natural sales order and catalog commands with demo gateway", async () => {
  const freeOrder = await runAgent({ message: "crie um pedido com 1 monitor e 1 notebook para o cliente Northstar" });
  assert.equal(freeOrder.preview?.customer.name, "Northstar Labs");
  assert.deepEqual(freeOrder.preview?.lines.map((line) => [line.name, line.quantity]), [
    ["Monitor 27 4K", 1],
    ["Notebook Air 14", 1]
  ]);

  const order = await runAgent({ message: "gere pedido para Northstar com dois monitores" });
  assert.equal(order.preview?.customer.name, "Northstar Labs");
  assert.equal(order.preview?.lines[0]?.quantity, 2);
  assert.match(order.message.text, /Preparei o pedido/i);

  const suffix = Math.random().toString(36).slice(2, 8);
  const productName = `Produto Frases Reais ${suffix}`;
  const created = await runAgent({ message: `cadastre o produto ${productName}` });
  assert.match(created.message.text, /cadastrado com sucesso/i);

  const listed = await runAgent({ message: `liste produtos ${productName}` });
  assert.match(listed.message.text, new RegExp(productName, "i"));
});

test("agent executes natural inventory and managerial report commands with demo gateway", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const productName = `Produto Estoque Frases ${suffix}`;
  await runAgent({ message: `cadastre o produto ${productName}` });

  const entry = await runAgent({ message: `dê entrada de 7 unidades no produto ${productName}` });
  assert.match(entry.message.text, /entrada/i);
  assert.match(entry.message.text, /quantidade 7/i);

  await runAgent({ message: "cadastre o produto mouse qa 1200" });
  const itemQuantityEntry = await runAgent({ message: "adicione 10 quantidades ao item mouse qa 1200" });
  assert.match(itemQuantityEntry.message.text, /entrada/i);
  assert.match(itemQuantityEntry.message.text, /Mouse qa 1200|mouse qa 1200/i);
  assert.match(itemQuantityEntry.message.text, /quantidade 10/i);

  const history = await runAgent({ message: `historico de estoque do produto ${productName}` });
  assert.match(history.message.text, /Historico de estoque/i);
  assert.match(history.message.text, new RegExp(productName, "i"));

  const stockPosition = await runAgent({ message: "liste o estoque" });
  assert.match(stockPosition.message.text, /Estoque atual/i);
  assert.match(stockPosition.message.text, /Produto \| Quantidade disponivel/i);
  assert.doesNotMatch(stockPosition.message.text, /Historico de estoque/i);

  const margin = await runAgent({ message: "gere um relatório de margem do mês" });
  assert.equal(margin.intelligentReport?.plan.metric, "sales");
  assert.match(margin.message.text, /Relatorio|Vendas|Margem|gerencial/i);

  const stockout = await runAgent({ message: "mostre o risco de ruptura de estoque" });
  assert.equal(stockout.intelligentReport?.plan.metric, "stock");
  assert.match(stockout.message.text, /estoque/i);

  const productRevenue = await runAgent({
    message: "quais produtos foram vendidos nos ultimos 30 dias, totalize por produto e mostre o valor total faturado de cada produto"
  });
  assert.equal(productRevenue.intelligentReport?.plan.dateRange, "last_30_days");
  assert.equal(productRevenue.intelligentReport?.plan.grain, "product");
  assert.deepEqual(productRevenue.intelligentReport?.columns, ["produto", "quantidade", "faturamento", "pedidos"]);
});

test("agent treats catalog delete language as safe product deactivation", async () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const productName = `MCP Migracao ${suffix}`;
  await demoCapabilityGateway.createProduct({ name: productName });

  const response = await runAgent({ message: `exclua o produto ${productName}` });
  const [beforeConfirmation] = await demoCapabilityGateway.searchProduct({ query: productName });
  assert.equal(response.pendingAction?.kind, "product.update");
  assert.equal(beforeConfirmation?.status, "active");

  const confirmed = await confirm(response);
  const [product] = await demoCapabilityGateway.searchProduct({ query: productName });

  assert.match(confirmed.message.text, /Produto .* inativado com sucesso\./);
  assert.equal(product?.status, "inactive");
});

test("agent asks clarifying questions for incomplete informal commands", async () => {
  const incompleteOrder = await runAgent({ message: "faz um pedido" });
  const vagueReport = await runAgent({ message: "quero um relatorio" });
  const vagueStock = await runAgent({ message: "mexer no estoque" });

  assert.match(incompleteOrder.message.text, /cliente|itens|pedido/i);
  assert.match(vagueReport.message.text, /relatorio|vendas|faturamento|margem/i);
  assert.match(vagueStock.message.text, /produto|estoque/i);
  assert.equal(incompleteOrder.auditEvents[0]?.action, "clarification_required");
});

test("agent applies discounts to the whole order or a specific item", async () => {
  const [customer] = await demoCapabilityGateway.searchCustomer({ query: "Northstar" });
  const [monitor] = await demoCapabilityGateway.searchProduct({ query: "monitor" });
  const [notebook] = await demoCapabilityGateway.searchProduct({ query: "notebook" });
  assert.ok(customer);
  assert.ok(monitor);
  assert.ok(notebook);

  const wholeOrderPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: customer.id,
    lines: [{ productId: monitor.id, quantity: 2 }]
  });
  const wholeOrder = await demoCapabilityGateway.createSalesOrder({ customerId: wholeOrderPreview.customer.id, lines: wholeOrderPreview.lines, confirmedByUser: true });
  const wholeOrderSubtotal = wholeOrder.subtotal;
  const wholeDiscountProposal = await runAgent({
    message: "aplique 10% de desconto no pedido",
    lastOrderId: wholeOrder.id
  });
  assert.equal(wholeDiscountProposal.pendingAction?.kind, "sales_order.discount");
  assert.equal(wholeDiscountProposal.order?.subtotal, wholeOrderSubtotal);

  const wholeDiscount = await confirm(wholeDiscountProposal);
  assert.equal(wholeDiscount.order?.subtotal, wholeOrderSubtotal * 0.9);
  assert.match(wholeDiscount.message.text, /desconto de 10% no pedido todo/i);

  const secondDiscountProposal = await runAgent({
    message: "aplique 10% de desconto no pedido",
    lastOrderId: wholeOrder.id
  });
  assert.ok(secondDiscountProposal.pendingAction?.details.some((detail) => /ja tem desconto acumulado/i.test(detail)));
  assert.equal(secondDiscountProposal.order?.subtotal, wholeOrderSubtotal * 0.9);

  const confirmedSecondDiscount = await confirm(secondDiscountProposal);
  assert.equal(confirmedSecondDiscount.order?.subtotal, wholeOrderSubtotal * 0.81);

  const itemPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: customer.id,
    lines: [
      { productId: monitor.id, quantity: 1 },
      { productId: notebook.id, quantity: 1 }
    ]
  });
  const itemOrder = await demoCapabilityGateway.createSalesOrder({ customerId: itemPreview.customer.id, lines: itemPreview.lines, confirmedByUser: true });
  const originalMonitorTotal = itemOrder.lines.find((line) => line.productId === monitor.id)!.total;
  const originalNotebookTotal = itemOrder.lines.find((line) => line.productId === notebook.id)!.total;
  const itemDiscount = await confirm(await runAgent({
    message: "de 100 reais de desconto no item monitor do pedido",
    lastOrderId: itemOrder.id
  }));
  const discountedMonitor = itemDiscount.order?.lines.find((line) => line.productId === monitor.id);
  const unchangedNotebook = itemDiscount.order?.lines.find((line) => line.productId === notebook.id);

  assert.equal(discountedMonitor?.total, originalMonitorTotal - 100);
  assert.equal(unchangedNotebook?.total, originalNotebookTotal);
});

test("agent filters listed orders by customer name after 'pedidos de'", async () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const joao = await demoCapabilityGateway.createCustomer({ name: `Joao Silva ${suffix}` });
  const [northstar] = await demoCapabilityGateway.searchCustomer({ query: "Northstar" });
  const [monitor] = await demoCapabilityGateway.searchProduct({ query: "monitor" });
  assert.ok(northstar);
  assert.ok(monitor);

  const joaoPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: joao.id,
    lines: [{ productId: monitor.id, quantity: 1 }]
  });
  const northstarPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: northstar.id,
    lines: [{ productId: monitor.id, quantity: 1 }]
  });
  const joaoOrder = await demoCapabilityGateway.createSalesOrder({ customerId: joaoPreview.customer.id, lines: joaoPreview.lines, confirmedByUser: true });
  const northstarOrder = await demoCapabilityGateway.createSalesOrder({ customerId: northstarPreview.customer.id, lines: northstarPreview.lines, confirmedByUser: true });

  const response = await runAgent({ message: `liste todos os pedidos de Joao Silva ${suffix}` });

  assert.match(response.message.text, new RegExp(joaoOrder.id));
  assert.doesNotMatch(response.message.text, new RegExp(northstarOrder.id));
  assert.match(response.message.text, new RegExp(`cliente Joao Silva ${suffix}`, "i"));
});

test("agent applies natural date filters when listing orders", async () => {
  const unavailableDay = await runAgent({ message: "liste os pedidos do dia 01/01/2020" });
  const lastWeek = await runAgent({ message: "exiba os pedidos da ultima semana" });
  const previousWeek = await runAgent({ message: "liste os pedidos da semana passada" });
  const lastMonth = await runAgent({ message: "liste os pedidos do ultimo mes" });

  assert.match(unavailableDay.message.text, /periodo 01\/01\/2020 a 01\/01\/2020/i);
  assert.match(lastWeek.message.text, /periodo \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/i);
  assert.doesNotMatch(lastWeek.message.text, /cliente ultima/i);
  assert.match(previousWeek.message.text, /periodo \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/i);
  assert.match(lastMonth.message.text, /periodo \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/i);
});
