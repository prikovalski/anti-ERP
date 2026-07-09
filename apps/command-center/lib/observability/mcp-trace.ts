import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";

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
  rootRun?: LangSmithRunTree | null;
};

const traceStorage = new AsyncLocalStorage<McpTraceContext>();
const globalForPrisma = globalThis as unknown as {
  mcpTracePrisma?: PrismaClient;
};

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

type LangSmithRunTree = {
  createChild(config: { name: string } & Record<string, unknown>): LangSmithRunTree;
  postRun(): Promise<void>;
  patchRun(): Promise<void>;
  end(outputs?: Record<string, unknown>, error?: string, endTime?: number, metadata?: Record<string, unknown>): Promise<void>;
};

function getLangSmithApiKey() {
  if (process.env.LANGSMITH_TRACING === "false") {
    return null;
  }
  return process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY ?? null;
}

export async function withMcpTrace<T>(
  config: {
    name: string;
    inputs?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    tags?: string[];
  },
  operation: () => Promise<T>
) {
  const context: McpTraceContext = {
    requestId: createId("req"),
    entries: [],
    rootRun: null
  };
  context.rootRun = await withTimeout(
    createLangSmithRootRun({
      name: config.name,
      requestId: context.requestId,
      inputs: config.inputs ?? {},
      metadata: config.metadata ?? {},
      tags: config.tags ?? []
    }),
    2500
  );

  const result = await traceStorage.run(context, async () => {
    await withTimeout(context.rootRun?.postRun() ?? Promise.resolve(), 2500);
    try {
      const output = await operation();
      await withTimeout(
        finalizeLangSmithRootRun(context.rootRun, {
          status: "success",
          entries: context.entries.length
        }),
        2500
      );
      return output;
    } catch (error) {
      await withTimeout(
        finalizeLangSmithRootRun(
          context.rootRun,
          {
            status: "error",
            entries: context.entries.length
          },
          summarizeError(error)
        ),
        2500
      );
      throw error;
    }
  });
  return {
    result,
    trace: context.entries
  };
}

export function getCurrentMcpRequestId() {
  return traceStorage.getStore()?.requestId ?? createId("req");
}

export async function recordAgentStep(input: {
  name: string;
  status: McpTraceStatus;
  durationMs: number;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: unknown;
}) {
  const context = traceStorage.getStore();
  const timestamp = new Date().toISOString();
  const entry = {
    requestId: context?.requestId ?? createId("req"),
    name: input.name,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    inputSummary: summarize(input.inputs ?? {}),
    outputSummary: input.status === "success" ? summarize(input.outputs ?? {}) : null,
    error: input.status === "error" ? summarizeError(input.error) : null,
    timestamp
  };

  console.info(JSON.stringify({ event: "agent_step", ...entry }));
  await withTimeout(sendLangSmithChildRun(context?.rootRun ?? null, {
    name: `agent.${input.name}`,
    runType: "chain",
    tags: ["anti-erp", "agent", input.name],
    requestId: entry.requestId,
    status: entry.status,
    durationMs: entry.durationMs,
    inputSummary: entry.inputSummary,
    outputSummary: entry.outputSummary,
    error: entry.error,
    timestamp
  }), 2500);
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
  await Promise.allSettled([persistMcpTrace(entry), withTimeout(sendLangSmithMcpTrace(context?.rootRun ?? null, entry), 2500)]);
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

  const client = await getTracePrisma() as PrismaClient & {
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

async function getTracePrisma() {
  if (globalForPrisma.mcpTracePrisma) {
    return globalForPrisma.mcpTracePrisma;
  }

  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
  });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.mcpTracePrisma = client;
  }

  return client;
}

async function createLangSmithRootRun(input: {
  name: string;
  requestId: string;
  inputs: Record<string, unknown>;
  metadata: Record<string, unknown>;
  tags: string[];
}): Promise<LangSmithRunTree | null> {
  const apiKey = getLangSmithApiKey();
  if (!apiKey) {
    return null;
  }

  const { RunTree } = await import("langsmith/run_trees");
  const { Client } = await import("langsmith");
  const client = new Client({
    apiKey,
    apiUrl: process.env.LANGSMITH_ENDPOINT ?? process.env.LANGCHAIN_ENDPOINT,
    workspaceId: process.env.LANGSMITH_WORKSPACE_ID ?? process.env.LANGCHAIN_WORKSPACE_ID,
    hideInputs: (values) => summarize(values),
    hideOutputs: (values) => summarize(values),
    hideMetadata: (values) => summarize(values)
  });
  return new RunTree({
    name: input.name,
    run_type: "chain",
    client,
    project_name: process.env.LANGSMITH_PROJECT ?? "anti-erp",
    inputs: {
      requestId: input.requestId,
      ...summarize(input.inputs)
    },
    tags: ["anti-erp", "agent-flow", ...input.tags],
    metadata: {
      requestId: input.requestId,
      ...summarize(input.metadata)
    }
  }) as LangSmithRunTree;
}

async function finalizeLangSmithRootRun(
  run: LangSmithRunTree | null | undefined,
  outputs: Record<string, unknown>,
  error?: string
) {
  if (!run) {
    return;
  }

  await run.end(summarize(outputs), error);
  await run.patchRun();
}

async function sendLangSmithMcpTrace(rootRun: LangSmithRunTree | null, entry: McpTraceEntry) {
  await sendLangSmithChildRun(rootRun, {
    name: `mcp.${entry.role}.${entry.tool}`,
    runType: "tool",
    tags: ["anti-erp", "mcp", entry.role, entry.tool],
    requestId: entry.requestId,
    status: entry.status,
    durationMs: entry.durationMs,
    inputSummary: entry.inputSummary ?? {},
    outputSummary: entry.outputSummary ?? {},
    error: entry.error ?? null,
    timestamp: entry.timestamp
  });
}

async function sendLangSmithChildRun(
  rootRun: LangSmithRunTree | null,
  input: {
    name: string;
    runType: string;
    tags: string[];
    requestId: string;
    status: McpTraceStatus;
    durationMs: number;
    inputSummary: Record<string, unknown>;
    outputSummary?: Record<string, unknown> | null;
    error?: string | null;
    timestamp: string;
  }
) {
  if (!rootRun || !getLangSmithApiKey()) {
    return;
  }

  const child = rootRun.createChild({
    name: input.name,
    run_type: input.runType,
    inputs: {
      requestId: input.requestId,
      inputSummary: input.inputSummary
    },
    tags: input.tags,
    metadata: {
      requestId: input.requestId,
      status: input.status,
      durationMs: input.durationMs
    },
    start_time: new Date(new Date(input.timestamp).getTime() - input.durationMs).toISOString()
  });

  await child.postRun();
  await child.end(
    input.status === "success" ? { outputSummary: input.outputSummary ?? {} } : undefined,
    input.error ?? undefined
  );
  await child.patchRun();
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
