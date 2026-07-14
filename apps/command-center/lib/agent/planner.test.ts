import assert from "node:assert/strict";
import test from "node:test";
import { parseIntentLocally } from "./intent-parser";
import { buildLocalExecutionPlan, toExecutionPlan } from "./planner";

test("parseIntentLocally detects a multi-step planned workflow", () => {
  const intent = parseIntentLocally(
    "Cadastre o cliente Aurora, cadastre o produto Mouse, crie um pedido para Aurora com 1 Mouse, gere a nota e um relatorio de vendas hoje"
  );

  assert.equal(intent.intent, "planned_workflow");
  assert.equal(intent.wantsInvoice, true);
});

test("buildLocalExecutionPlan creates ordered actions for composite requests", () => {
  const workflow = buildLocalExecutionPlan(
    "Cadastre o cliente Aurora, cadastre o produto Mouse, crie um pedido para Aurora com 1 Mouse, gere a nota e um relatorio de vendas hoje"
  );

  assert.ok(workflow);
  assert.deepEqual(workflow.actions.map((action) => action.type), [
    "create_customer",
    "create_product",
    "prepare_sales_order",
    "query_report"
  ]);

  const plan = toExecutionPlan(workflow);
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.steps[0]?.action, "create_customer");
  assert.equal(plan.steps[2]?.action, "prepare_sales_order");
  assert.equal(plan.steps[3]?.action, "query_report");
});
