"use client";

import type {
  AgentResponse,
  AnalyticsResult,
  AuditEvent,
  ConceptInvoice,
  SalesOrder,
  SalesOrderPreview
} from "@anti-erp/shared";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  CircleDollarSign,
  Clock3,
  FileText,
  GitBranch,
  PackageCheck,
  ReceiptText,
  Send,
  Sparkles,
  UserCheck
} from "lucide-react";
import { useMemo, useState } from "react";

type Message = {
  id: string;
  role: "user" | "agent";
  text: string;
};

type ApiErrorResponse = {
  message?: string;
  error?: string;
};

type McpTrace = NonNullable<AgentResponse["mcpTrace"]>;

function createAudit(action: string, summary: string, actor: AuditEvent["actor"] = "mcp-tool"): AuditEvent {
  return {
    id: `${action}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    actor,
    action,
    summary
  };
}

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}

function formatAnalyticsValue(result: AnalyticsResult) {
  return result.metric === "revenue" ? money(result.value) : String(result.value);
}

function formatAnalyticsRowValue(result: AnalyticsResult, value: number) {
  return result.metric === "revenue" ? money(value) : String(value);
}

function formatAnalyticsGroupBy(result: AnalyticsResult) {
  return result.query.groupBy ? result.query.groupBy : "none";
}

export default function CommandCenterPage() {
  const [input, setInput] = useState("Crie um pedido para Northstar com 10 notebooks e gere a nota.");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "agent",
      text: "Como posso ajudar? Diga a intenção de negócio; eu transformo isso em capacidades MCP auditáveis."
    }
  ]);
  const [preview, setPreview] = useState<SalesOrderPreview | null>(null);
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [invoice, setInvoice] = useState<ConceptInvoice | null>(null);
  const [analyticsResult, setAnalyticsResult] = useState<AnalyticsResult | null>(null);
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<AgentResponse["mode"]>("demo-agent");
  const [mcpTrace, setMcpTrace] = useState<McpTrace>([]);
  const [createInvoiceAfterConfirm, setCreateInvoiceAfterConfirm] = useState(true);
  const [pending, setPending] = useState(false);
  const [audit, setAudit] = useState<AuditEvent[]>([
    createAudit("session_started", "Command Center opened in demo-safe mode.", "system")
  ]);

  const suggestions = useMemo(
    () => [
      "Crie um pedido para Northstar com 10 notebooks",
      "Crie o pedido e a NF para Globo com 1 monitor e 1 teclado",
      "Cadastre o cliente Atlas Retail",
      "Cadastre o produto Mouse",
      "Cadastre o fornecedor Delta Supplies",
      "Atualize o preço do produto Mouse para 50 reais",
      "Quantos monitores foram vendidos hoje?",
      "Quanto vendemos hoje?",
      "Qual cliente comprou mais este mês?",
      "Quanto vendemos por produto?",
      "Gere uma nota para o último pedido",
      "Explique como isso seria feito em um ERP tradicional"
    ],
    []
  );

  function applyAgentResponse(response: AgentResponse) {
    setMessages((current) => [...current, response.message]);
    setAgentMode(response.mode);
    setPreview(response.preview ?? null);
    setOrder(response.order ?? order);
    setInvoice(response.invoice ?? invoice);
    setAnalyticsResult(response.analyticsResult ?? null);
    setLastOrderId(response.lastOrderId ?? lastOrderId);
    setMcpTrace(response.mcpTrace ?? []);
    setAudit((current) => [...response.auditEvents, ...current]);
  }

  async function readApiError(response: Response, fallback: string) {
    try {
      const payload = (await response.json()) as ApiErrorResponse;
      return payload.message ?? fallback;
    } catch {
      return fallback;
    }
  }

  async function runIntent(command: string) {
    if (!command.trim()) {
      return;
    }

    setMessages((current) => [
      ...current,
      { id: `user_${Date.now()}`, role: "user", text: command }
    ]);
    setPending(true);
    setCreateInvoiceAfterConfirm(/\b(nota|invoice|fatura)\b/i.test(command));
    setOrder(null);
    setInvoice(null);
    setAnalyticsResult(null);
    setMcpTrace([]);
    setInput("");

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: command,
          lastOrderId: lastOrderId ?? undefined
        })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, `Agent request failed with ${response.status}`));
      }

      applyAgentResponse((await response.json()) as AgentResponse);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `agent_error_${Date.now()}`,
          role: "agent",
          text: error instanceof Error
            ? error.message
            : "Nao consegui processar esse comando agora. A demo continua segura: nenhuma escrita foi executada."
        }
      ]);
      setAudit((current) => [
        createAudit("agent_request_failed", "Command Center could not reach the agent API.", "system"),
        ...current
      ]);
    } finally {
      setPending(false);
    }
  }

  async function confirmPreview() {
    if (!preview) {
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/agent/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          preview,
          createInvoice: createInvoiceAfterConfirm
        })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, `Confirm request failed with ${response.status}`));
      }

      setAudit((current) => [
        createAudit("user_approval", "User explicitly confirmed the sales order preview.", "user"),
        ...current
      ]);
      applyAgentResponse((await response.json()) as AgentResponse);
      setPreview(null);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `agent_confirm_error_${Date.now()}`,
          role: "agent",
          text: error instanceof Error
            ? error.message
            : "Nao consegui confirmar o pedido agora. Nenhuma criacao foi aplicada."
        }
      ]);
      setAudit((current) => [
        createAudit("confirmation_failed", "The confirmation request failed before creating a sales order.", "system"),
        ...current
      ]);
    } finally {
      setPending(false);
    }
  }

  const confirmationBlocked = Boolean(preview?.warnings.length);

  return (
    <main className="min-h-screen bg-paper text-ink">
      <section className="border-b border-line bg-[linear-gradient(120deg,#f7f5ef_0%,#ffffff_48%,#eef6f3_100%)]">
        <div className="mx-auto grid min-h-[92vh] w-full max-w-7xl grid-cols-1 gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
          <div className="flex min-h-[680px] flex-col rounded-lg border border-line bg-white shadow-panel">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-signal">anti-ERP</p>
                <h1 className="text-2xl font-semibold text-ink sm:text-4xl">
                  The first MCP-native AI ERP experiment.
                </h1>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-line px-3 py-2 text-sm text-steel">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {agentMode === "openrouter" ? "OpenRouter assisted" : "demo-safe mode"}
              </div>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
              <blockquote className="border-l-4 border-coral pl-4 text-xl font-medium text-ink">
                You shouldn't learn an ERP. Your ERP should understand your intent.
              </blockquote>

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[86%] rounded-lg border px-4 py-3 text-sm leading-6 ${
                    message.role === "user"
                      ? "ml-auto border-signal bg-[#e9f6f3]"
                      : "border-line bg-[#fbfaf7]"
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-steel">
                    {message.role === "agent" ? <Bot className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                    {message.role === "agent" ? "Agent" : "User"}
                  </div>
                  {message.text}
                </div>
              ))}

              <AgentPlan audit={audit} pending={pending} preview={preview} order={order} invoice={invoice} />

              {preview ? (
                <div className="rounded-lg border border-signal bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-signal">Confirmation card</p>
                      <h2 className="mt-1 text-xl font-semibold">Create sales order for {preview.customer.name}</h2>
                      <p className="mt-1 text-sm text-steel">
                        This is a preview. The agent cannot write to the system before your confirmation.
                      </p>
                    </div>
                    <button
                      className="inline-flex min-h-11 items-center gap-2 rounded-md bg-signal px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={confirmPreview}
                      disabled={pending || confirmationBlocked}
                      title="Confirm and create order"
                    >
                      <Check className="h-5 w-5" aria-hidden="true" />
                      Confirm
                    </button>
                  </div>

                  {preview.warnings.length > 0 ? (
                    <div className="mt-4 rounded-md border border-coral bg-[#fff3ef] p-3 text-sm text-ink">
                      <div className="flex items-center gap-2 font-semibold text-coral">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        Confirmation blocked
                      </div>
                      <ul className="mt-2 space-y-1">
                        {preview.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <Metric label="Customer" value={preview.customer.name} />
                    <Metric label="Tax ID" value={preview.customer.taxId} />
                    <Metric label="City" value={preview.customer.city} />
                  </div>

                  <div className="mt-4 overflow-hidden rounded-md border border-line">
                    <div className="grid grid-cols-[1fr_0.55fr_0.7fr_0.7fr] bg-[#fbfaf7] px-3 py-2 text-xs font-semibold uppercase text-steel">
                      <span>Item</span>
                      <span>Qty</span>
                      <span>Unit</span>
                      <span>Total</span>
                    </div>
                    {preview.lines.map((line) => (
                      <div
                        key={`${line.productId}-${line.quantity}`}
                        className="grid grid-cols-[1fr_0.55fr_0.7fr_0.7fr] border-t border-line px-3 py-3 text-sm"
                      >
                        <div>
                          <p className="font-semibold text-ink">{line.name}</p>
                          <p className="text-xs text-steel">{line.sku}</p>
                        </div>
                        <span>{line.quantity}</span>
                        <span>{money(line.unitPrice)}</span>
                        <span className="font-semibold">{money(line.total)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        checked={createInvoiceAfterConfirm}
                        className="h-4 w-4 accent-signal"
                        onChange={(event) => setCreateInvoiceAfterConfirm(event.target.checked)}
                        type="checkbox"
                      />
                      Generate concept invoice after confirmation
                    </label>
                    <Metric label="Subtotal" value={money(preview.subtotal)} />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-line p-4">
              <div className="mb-3 flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="rounded-md border border-line bg-white px-3 py-2 text-left text-sm text-steel hover:border-signal hover:text-ink"
                    onClick={() => setInput(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              <form
                className="flex gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  runIntent(input);
                }}
              >
                <textarea
                  className="min-h-16 flex-1 resize-none rounded-lg border border-line bg-white px-4 py-3 text-base"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  aria-label="Business command"
                />
                <button
                  className="inline-flex min-h-16 w-16 items-center justify-center rounded-lg bg-ink text-white disabled:cursor-not-allowed disabled:opacity-60"
                  type="submit"
                  disabled={pending}
                  title="Send command"
                >
                  <Send className="h-6 w-6" aria-hidden="true" />
                </button>
              </form>
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-steel">
                <GitBranch className="h-4 w-4" aria-hidden="true" />
                MCP-native architecture
              </div>
              <div className="grid gap-2 text-sm">
                {[
                  "Command Center",
                  "Agent",
                  "MCP Client",
                  "Customers MCP",
                  "Products MCP",
                  "Suppliers MCP",
                  "Sales Orders MCP",
                  "Invoices MCP",
                  "Analytics MCP",
                  "Database"
                ].map((step) => (
                  <div key={step} className="rounded-md border border-line px-3 py-2">
                    {step}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-steel">
                <CircleDollarSign className="h-4 w-4" aria-hidden="true" />
                Result
              </div>
              {order ? (
                <div className="space-y-3 text-sm">
                  <Metric label="Sales order" value={order.id} />
                  <Metric label="Concept invoice" value={invoice?.id ?? "Not generated"} />
                  <Metric label="Amount" value={money(invoice?.amount ?? order.subtotal)} />
                </div>
              ) : analyticsResult ? (
                <div className="space-y-3 text-sm">
                  <Metric label={analyticsResult.label} value={formatAnalyticsValue(analyticsResult)} />
                  <div className="rounded-md border border-line bg-[#fbfaf7] px-3 py-3">
                    <p className="text-xs font-semibold uppercase text-steel">Interpreted query</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className="rounded-full border border-line bg-white px-2 py-1 text-xs text-steel">
                        {analyticsResult.query.capability}
                      </span>
                      <span className="rounded-full border border-line bg-white px-2 py-1 text-xs text-steel">
                        source: {analyticsResult.query.dataSource}
                      </span>
                      <span className="rounded-full border border-line bg-white px-2 py-1 text-xs text-steel">
                        group: {formatAnalyticsGroupBy(analyticsResult)}
                      </span>
                      {analyticsResult.query.filters.map((filter) => (
                        <span key={`${filter.label}-${filter.value}`} className="rounded-full border border-line bg-white px-2 py-1 text-xs text-steel">
                          {filter.label}: {filter.value}
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-steel">
                      Entities: {analyticsResult.query.entities.join(", ")}
                    </p>
                  </div>
                  {analyticsResult.rows.length > 0 ? (
                    <div className="overflow-hidden rounded-md border border-line">
                      {analyticsResult.rows.map((row) => (
                        <div
                          key={row.label}
                          className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 first:border-t-0"
                        >
                          <span className="text-steel">{row.label}</span>
                          <span className="font-semibold text-ink">{formatAnalyticsRowValue(analyticsResult, row.value)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm leading-6 text-steel">A confirmed order, concept invoice, or sales metric will appear here.</p>
              )}
            </section>

            <ExecutionTrace trace={mcpTrace} />

            <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-steel">
                <Clock3 className="h-4 w-4" aria-hidden="true" />
                Audit timeline
              </div>
              <div className="space-y-3">
                {audit.map((event) => (
                  <div key={event.id} className="border-l-2 border-signal pl-3">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase text-steel">
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      {event.action}
                    </div>
                    <p className="mt-1 text-sm text-ink">{event.summary}</p>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-[#fbfaf7] px-3 py-3">
      <p className="text-xs font-semibold uppercase text-steel">{label}</p>
      <p className="mt-1 break-words text-base font-semibold text-ink">{value}</p>
    </div>
  );
}

function ExecutionTrace({ trace }: { trace: McpTrace }) {
  return (
    <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-steel">
        <Activity className="h-4 w-4" aria-hidden="true" />
        Execution trace
      </div>
      {trace.length > 0 ? (
        <div className="space-y-2">
          {trace.map((entry) => (
            <div key={entry.id} className="rounded-md border border-line bg-[#fbfaf7] px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink">
                  {entry.role}.{entry.tool}
                </span>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-semibold ${
                    entry.status === "success" ? "bg-[#e9f6f3] text-signal" : "bg-[#fff3ef] text-coral"
                  }`}
                >
                  {entry.status} · {entry.durationMs}ms
                </span>
              </div>
              {entry.error ? (
                <p className="mt-2 text-xs leading-5 text-coral">{entry.error}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm leading-6 text-steel">MCP calls from the latest command will appear here.</p>
      )}
    </section>
  );
}

function AgentPlan({
  audit,
  pending,
  preview,
  order,
  invoice
}: {
  audit: AuditEvent[];
  pending: boolean;
  preview: SalesOrderPreview | null;
  order: SalesOrder | null;
  invoice: ConceptInvoice | null;
}) {
  const completedActions = new Set(audit.map((event) => event.action));
  const blocked = Boolean(preview?.warnings.length);
  const steps = [
    { action: "search_customer", label: "Resolve customer", icon: UserCheck },
    { action: "search_product", label: "Resolve product", icon: PackageCheck },
    { action: "validate_stock", label: "Validate stock", icon: PackageCheck },
    { action: "prepare_sales_order", label: "Prepare order preview", icon: FileText },
    { action: "user_approval", label: "Human approval", icon: Check },
    { action: "create_sales_order", label: "Create sales order", icon: CircleDollarSign },
    { action: "create_concept_invoice", label: "Generate concept invoice", icon: ReceiptText }
  ];

  if (!pending && !preview && !order && !invoice && !steps.some((step) => completedActions.has(step.action))) {
    return null;
  }

  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-steel">
        <GitBranch className="h-4 w-4" aria-hidden="true" />
        Agent execution plan
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {steps.map((step) => {
          const Icon = step.icon;
          const completed = completedActions.has(step.action);
          const isApprovalBlocked = step.action === "user_approval" && blocked;
          const status = completed ? "completed" : isApprovalBlocked ? "blocked" : pending ? "pending" : "waiting";

          return (
            <div key={step.action} className="flex items-center justify-between rounded-md border border-line px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <Icon className="h-4 w-4 text-steel" aria-hidden="true" />
                {step.label}
              </span>
              <span
                className={`rounded-full px-2 py-1 text-xs font-semibold ${
                  status === "completed"
                    ? "bg-[#e9f6f3] text-signal"
                    : status === "blocked"
                      ? "bg-[#fff3ef] text-coral"
                      : "bg-[#fbfaf7] text-steel"
                }`}
              >
                {status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
