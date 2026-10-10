import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AgentResponse } from "@anti-erp/shared";
import { executeClassification } from "./agent";
import { classifyCommand } from "./nlu/classifier";
import type { Classification } from "./nlu/commands";

const AgentGraphState = Annotation.Root({
  message: Annotation<string | undefined>,
  lastOrderId: Annotation<string | undefined>,
  classification: Annotation<Classification | null>,
  response: Annotation<AgentResponse | null>
});

/**
 * LangGraph Studio view of the production agent: the same classifier and handlers as /api/agent,
 * split into two nodes so each run shows the chosen command and its candidates.
 */
export const antiErpAgentGraph = new StateGraph(AgentGraphState)
  .addNode("classify", async (state) => ({
    classification: await classifyCommand(state.message ?? "")
  }))
  .addNode("execute", async (state) => ({
    response: await executeClassification(
      state.classification ?? { command: { kind: "unknown" }, confidence: 0.4, source: "rules", candidates: [] },
      { message: state.message ?? "", lastOrderId: state.lastOrderId ?? null }
    )
  }))
  .addEdge(START, "classify")
  .addEdge("classify", "execute")
  .addEdge("execute", END)
  .compile();
