import assert from "node:assert/strict";
import test from "node:test";
import { antiErpAgentGraph } from "./agent-graph";

test("antiErpAgentGraph handles empty Studio input without crashing", async () => {
  const result = await antiErpAgentGraph.invoke({});

  assert.equal(result.intent?.intent, "unknown");
  assert.equal(result.response?.message.role, "agent");
  assert.match(result.response?.message.text ?? "", /Posso cadastrar clientes/);
});
