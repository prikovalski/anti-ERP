import type { CapabilityGateway } from "../capabilities";
import { recordAgentStep } from "./mcp-trace";

export function createObservedCapabilityGateway(gateway: CapabilityGateway, scope = "capability"): CapabilityGateway {
  return new Proxy(gateway, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }

      return async (...args: unknown[]) => {
        const startedAt = performance.now();
        try {
          const output = await value.apply(target, args);
          await recordAgentStep({
            name: `${scope}.${property}`,
            kind: "capability",
            status: "success",
            durationMs: performance.now() - startedAt,
            inputs: { args },
            outputs: summarizeCapabilityOutput(output)
          });
          return output;
        } catch (error) {
          await recordAgentStep({
            name: `${scope}.${property}`,
            kind: "capability",
            status: "error",
            durationMs: performance.now() - startedAt,
            inputs: { args },
            error
          });
          throw error;
        }
      };
    }
  });
}

function summarizeCapabilityOutput(output: unknown) {
  if (Array.isArray(output)) {
    return { outputType: "array", count: output.length };
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    return {
      outputType: "object",
      id: typeof record.id === "string" ? record.id : null,
      kind: typeof record.kind === "string" ? record.kind : null,
      status: typeof record.status === "string" ? record.status : null,
      rowCount: Array.isArray(record.rows) ? record.rows.length : null,
      lineCount: Array.isArray(record.lines) ? record.lines.length : null
    };
  }
  return { value: output };
}
