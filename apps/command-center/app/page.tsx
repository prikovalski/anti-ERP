"use client";

import type { AuditEvent, ConceptInvoice, SalesOrder, SalesOrderPreview } from "@anti-erp/shared";
import { Bot, Check, CircleDollarSign, Clock3, FileText, GitBranch, Send, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

type Message = {
  id: string;
  role: "user" | "agent";
  text: string;
};

const customer = {
  id: "cus_acme",
  name: "ACME Industries",
  taxId: "12.345.678/0001-90",
  city: "Sao Paulo",
  status: "active" as const
};

const notebook = {
  id: "prd_notebook_air",
  sku: "NB-AIR-14",
  name: "Notebook Air 14",
  unitPrice: 6200,
  availableStock: 37
};

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

function buildPreview(quantity: number): SalesOrderPreview {
  return {
    customer,
    lines: [
      {
        productId: notebook.id,
        sku: notebook.sku,
        name: notebook.name,
        quantity,
        unitPrice: notebook.unitPrice,
        total: notebook.unitPrice * quantity
      }
    ],
    subtotal: notebook.unitPrice * quantity,
    warnings: [],
    confirmationRequired: true
  };
}

export default function CommandCenterPage() {
  const [input, setInput] = useState("Crie um pedido para ACME com 10 notebooks e gere a nota.");
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
  const [audit, setAudit] = useState<AuditEvent[]>([
    createAudit("session_started", "Command Center opened in demo-safe mode.", "system")
  ]);

  const suggestions = useMemo(
    () => [
      "Crie um pedido para ACME com 10 notebooks",
      "Gere uma nota para o último pedido",
      "Liste os pedidos criados hoje",
      "Explique como isso seria feito em um ERP tradicional"
    ],
    []
  );

  function runIntent(command: string) {
    if (!command.trim()) {
      return;
    }

    const quantityMatch = command.match(/(\d+)\s+(notebook|notebooks)/i);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : 10;
    const nextPreview = buildPreview(quantity);

    setMessages((current) => [
      ...current,
      { id: `user_${Date.now()}`, role: "user", text: command },
      {
        id: `agent_${Date.now()}`,
        role: "agent",
        text: "Encontrei ACME, localizei Notebook Air 14, validei estoque e preparei uma previa. Preciso da sua confirmacao antes de criar o pedido."
      }
    ]);
    setPreview(nextPreview);
    setOrder(null);
    setInvoice(null);
    setAudit((current) => [
      createAudit("search_customer", "Matched customer ACME Industries."),
      createAudit("search_product", "Matched product Notebook Air 14."),
      createAudit("validate_stock", `Validated ${quantity} units against ${notebook.availableStock} in stock.`),
      createAudit("prepare_sales_order", `Prepared preview for ${money(nextPreview.subtotal)}.`),
      ...current
    ]);
    setInput("");
  }

  function confirmPreview() {
    if (!preview) {
      return;
    }

    const createdOrder: SalesOrder = {
      ...preview,
      id: `SO-${Math.floor(1000 + Math.random() * 9000)}`,
      status: "confirmed",
      createdAt: new Date().toISOString()
    };
    const createdInvoice: ConceptInvoice = {
      id: `CI-${Math.floor(1000 + Math.random() * 9000)}`,
      salesOrderId: createdOrder.id,
      customerName: createdOrder.customer.name,
      amount: createdOrder.subtotal,
      issuedAt: new Date().toISOString(),
      disclaimer: "Concept invoice for portfolio demo only. Not a fiscal document."
    };

    setOrder(createdOrder);
    setInvoice(createdInvoice);
    setPreview(null);
    setMessages((current) => [
      ...current,
      {
        id: `agent_done_${Date.now()}`,
        role: "agent",
        text: `Pedido ${createdOrder.id} criado e nota conceitual ${createdInvoice.id} gerada. Tudo ficou registrado na timeline.`
      }
    ]);
    setAudit((current) => [
      createAudit("create_sales_order", `Created sales order ${createdOrder.id}.`),
      createAudit("create_concept_invoice", `Generated concept invoice ${createdInvoice.id}.`),
      ...current
    ]);
  }

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
                demo-safe mode
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
                      className="inline-flex min-h-11 items-center gap-2 rounded-md bg-signal px-4 py-2 font-semibold text-white"
                      onClick={confirmPreview}
                      title="Confirm and create order"
                    >
                      <Check className="h-5 w-5" aria-hidden="true" />
                      Confirm
                    </button>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <Metric label="Customer" value={preview.customer.name} />
                    <Metric label="Items" value={`${preview.lines[0]?.quantity ?? 0} notebooks`} />
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
                  className="inline-flex min-h-16 w-16 items-center justify-center rounded-lg bg-ink text-white"
                  type="submit"
                  title="Send command"
                >
                  <Send className="h-6 w-6" aria-hidden="true" />
                </button>
              </form>
            </div>
          </div>

          <aside className="grid gap-6 lg:grid-rows-[auto_auto_1fr]">
            <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-steel">
                <GitBranch className="h-4 w-4" aria-hidden="true" />
                MCP-native architecture
              </div>
              <div className="grid gap-2 text-sm">
                {["Command Center", "Agent", "MCP Client", "anti-ERP MCP Server", "Domain Services", "Database"].map(
                  (step) => (
                    <div key={step} className="rounded-md border border-line px-3 py-2">
                      {step}
                    </div>
                  )
                )}
              </div>
            </section>

            <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-steel">
                <CircleDollarSign className="h-4 w-4" aria-hidden="true" />
                Result
              </div>
              {order && invoice ? (
                <div className="space-y-3 text-sm">
                  <Metric label="Sales order" value={order.id} />
                  <Metric label="Concept invoice" value={invoice.id} />
                  <Metric label="Amount" value={money(invoice.amount)} />
                </div>
              ) : (
                <p className="text-sm leading-6 text-steel">A confirmed order and concept invoice will appear here.</p>
              )}
            </section>

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
