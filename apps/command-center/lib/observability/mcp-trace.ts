import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient } from "@prisma/client";

type McpTraceStatus = "success" | "error";

export type McpTraceEntry = {
  id: string;
  requestId: string;
  role: string;
  tool: string;
  status: McpTraceStatus;
  durationMs: number;
  inputSummary?: Record<string, unknown> | null;
  outputSummary?: Record<string, unknown> | null;
  error?: string | null;
  timestamp: string;
};

type McpTraceContext = {
  requestId: string;
  entries: McpTraceEntry[];
};

const traceStorage = new AsyncLocalStorage<McpTraceContext>();
const globalForPrisma = globalThis as unknown as {
  mcpTracePrisma?: PrismaClient;
};

const prisma =
  globalForPrisma.mcpTracePrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.mcpTracePrisma = prisma;
}

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function withMcpTrace<T>(operation: () => Promise<T>) {
  const context: McpTraceContext = {
    requestId: createId("req"),
    entries: []
  };
  const result = await traceStorage.run(context, operation);
  return {
    result,
    trace: context.entries
  };
}

export function getCurrentMcpRequestId() {
  return traceStorage.getStore()?.requestId ?? createId("req");
}

export async function recordMcpCall(input: {
  role: string;
  tool: string;
  status: McpTraceStatus;
  durationMs: number;
  args: Record<string, unknown>;
  output?: unknown;
  error?: unknown;
}) {
  const context = traceStorage.getStore();
  const entry: McpTraceEntry = {
    id: createId("mcp"),
    requestId: context?.requestId ?? createId("req"),
    role: input.role,
    tool: input.tool,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    inputSummary: summarize(input.args),
    outputSummary: input.status === "success" ? summarize(input.output) : null,
    error: input.status === "error" ? summarizeError(input.error) : null,
    timestamp: new Date().toISOString()
  };

  context?.entries.push(entry);
  console.info(JSON.stringify({ event: "mcp_call", ...entry }));
  await Promise.allSettled([persistMcpTrace(entry), withTimeout(sendLangSmithTrace(entry), 2500)]);
}

function summarize(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length
    };
  }

  if (!value || typeof value !== "object") {
    return {
      value: sanitizeScalar(value)
    };
  }

  const summary: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      summary[key] = "[redacted]";
      continue;
    }

    if (Array.isArray(rawValue)) {
      summary[key] = {
        type: "array",
        count: rawValue.length
      };
      continue;
    }

    if (rawValue && typeof rawValue === "object") {
      summary[key] = summarizeObject(rawValue as Record<string, unknown>);
      continue;
    }

    summary[key] = sanitizeScalar(rawValue);
  }
  return summary;
}

function summarizeObject(value: Record<string, unknown>) {
  const id = typeof value.id === "string" ? value.id : null;
  const name = typeof value.name === "string" ? value.name : null;
  const keys = Object.keys(value);
  return {
    type: "object",
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    keys: keys.slice(0, 8)
  };
}

function sanitizeScalar(value: unknown) {
  if (typeof value === "string") {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  return String(value);
}

function isSensitiveKey(key: string) {
  return /key|token|secret|password|authorization|database_url|url|taxid/i.test(key);
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return error.message.slice(0, 240);
  }
  return String(error).slice(0, 240);
}

async function persistMcpTrace(entry: McpTraceEntry) {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const client = prisma as PrismaClient & {
    mcpCallLog?: {
      create(input: {
        data: {
          requestId: string;
          role: string;
          tool: string;
          status: string;
          durationMs: number;
          inputSummary?: Record<string, unknown>;
          outputSummary?: Record<string, unknown>;
          error?: string;
        };
      }): Promise<unknown>;
    };
  };

  if (!client.mcpCallLog) {
    return;
  }

  await client.mcpCallLog.create({
    data: {
      requestId: entry.requestId,
      role: entry.role,
      tool: entry.tool,
      status: entry.status,
      durationMs: entry.durationMs,
      inputSummary: entry.inputSummary ?? undefined,
      outputSummary: entry.outputSummary ?? undefined,
      error: entry.error ?? undefined
    }
  });
}

async function sendLangSmithTrace(entry: McpTraceEntry) {
  if (!process.env.LANGSMITH_API_KEY) {
    return;
  }

  const { RunTree } = await import("langsmith/run_trees");
  const run = new RunTree({
    name: `mcp.${entry.role}.${entry.tool}`,
    run_type: "tool",
    project_name: process.env.LANGSMITH_PROJECT ?? "anti-erp",
    inputs: {
      requestId: entry.requestId,
      role: entry.role,
      tool: entry.tool,
      inputSummary: entry.inputSummary ?? {}
    },
    outputs: entry.status === "success" ? { outputSummary: entry.outputSummary ?? {} } : undefined,
    error: entry.error ?? undefined,
    tags: ["anti-erp", "mcp", entry.role, entry.tool],
    metadata: {
      requestId: entry.requestId,
      role: entry.role,
      tool: entry.tool,
      status: entry.status,
      durationMs: entry.durationMs
    },
    start_time: new Date(new Date(entry.timestamp).getTime() - entry.durationMs).toISOString(),
    end_time: entry.timestamp
  });

  await run.postRun();
  await run.patchRun();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
