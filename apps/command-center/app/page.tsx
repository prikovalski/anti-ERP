"use client";

import type {
  AgentResponse,
  AnalyticsResult,
  AuditEvent,
  ConceptInvoice,
  ConversationContext,
  ExecutionPlan,
  SalesOrder,
  SalesOrderPreview
} from "@anti-erp/shared";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  FileText,
  ReceiptText,
  Send,
  Sparkles
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

type DocumentMessage = {
  id: string;
  text: string;
  title: string;
};

const emptyConversationContext: ConversationContext = {
  activeOrderId: null,
  activeInvoiceId: null,
  activeCustomer: null,
  activeProducts: [],
  lastDocumentType: null,
  pendingConfirmation: "none",
  lastUserCommand: null,
  lastAgentSummary: null
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatAnalyticsValue(result: AnalyticsResult, value = result.value) {
  return result.metric === "revenue" ? money(value) : String(value);
}

function formatPlanStatus(status: ExecutionPlan["steps"][number]["status"]) {
  if (status === "executed") {
    return "Executada";
  }
  if (status === "pending_confirmation") {
    return "Pendente";
  }
  if (status === "blocked") {
    return "Bloqueada";
  }
  if (status === "skipped") {
    return "Ignorada";
  }
  return "Planejada";
}

export default function CommandCenterPage() {
  const [input, setInput] = useState("Crie um pedido para Northstar com 10 notebooks e gere a nota.");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "agent",
      text: "Diga o que deseja fazer em linguagem natural. Eu transformo em acoes MCP auditaveis."
    }
  ]);
  const [preview, setPreview] = useState<SalesOrderPreview | null>(null);
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [invoice, setInvoice] = useState<ConceptInvoice | null>(null);
  const [analyticsResult, setAnalyticsResult] = useState<AnalyticsResult | null>(null);
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan | null>(null);
  const [documentMessage, setDocumentMessage] = useState<DocumentMessage | null>(null);
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);
  const [conversationContext, setConversationContext] = useState<ConversationContext>(emptyConversationContext);
  const [agentMode, setAgentMode] = useState<AgentResponse["mode"]>("langgraph");
  const [mcpTrace, setMcpTrace] = useState<McpTrace>([]);
  const [createInvoiceAfterConfirm, setCreateInvoiceAfterConfirm] = useState(true);
  const [pending, setPending] = useState(false);
  const [audit, setAudit] = useState<AuditEvent[]>([
    createAudit("session_started", "Command Center opened in LangGraph mode.", "system")
  ]);

  const suggestions = useMemo(
    () => [
      "Crie um pedido para Northstar com 10 notebooks",
      "Crie o pedido e a NF para Globo com 1 monitor e 1 teclado",
      "Cadastre o cliente Atlas Retail",
      "Cadastre o produto Mouse",
      "Atualize o preco do produto Mouse para 50 reais",
      "Quais produtos estao com estoque baixo?",
      "Quais produtos mais venderam hoje?",
      "Compare o faturamento de notebooks e monitores hoje"
    ],
    []
  );

  function applyAgentResponse(response: AgentResponse) {
    if (isAgentQuestion(response.message.text)) {
      setMessages((current) => [...current, response.message]);
      setDocumentMessage(null);
    } else {
      setDocumentMessage({
        id: response.message.id,
        title: inferDocumentTitle(response),
        text: response.message.text
      });
    }
    setAgentMode(response.mode);
    setPreview(response.preview ?? null);
    setOrder(response.order ?? order);
    setInvoice(response.invoice ?? invoice);
    setAnalyticsResult(response.analyticsResult ?? null);
    setExecutionPlan(response.executionPlan ?? null);
    setLastOrderId(response.lastOrderId ?? lastOrderId);
    setConversationContext(response.conversationContext ?? conversationContext);
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
    setCreateInvoiceAfterConfirm(/\b(nota|nf|invoice|fatura)\b/i.test(command));
    setOrder(null);
    setInvoice(null);
    setAnalyticsResult(null);
    setExecutionPlan(null);
    setDocumentMessage(null);
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
          lastOrderId: lastOrderId ?? conversationContext.activeOrderId ?? undefined,
          conversationContext
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
            : "Nao consegui processar esse comando agora. Nenhuma escrita foi executada."
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
          createInvoice: createInvoiceAfterConfirm,
          conversationContext
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

  return (
    <main className="anti-erp-shell">
      <aside className="chat-column">
        <div className="chat-brand">
          <div>
            <p className="eyebrow">anti-ERP</p>
            <h1>Command Center</h1>
          </div>
          <span className="mode-pill">
            <Sparkles size={15} />
            {agentMode === "openrouter" ? "OpenRouter" : "LangGraph"}
          </span>
        </div>

        <div className="chat-messages" aria-live="polite">
          {messages.map((message) => (
            <div key={message.id} className={`chat-bubble ${message.role}`}>
              <div className="bubble-role">
                {message.role === "agent" ? <Bot size={14} /> : <Send size={14} />}
                {message.role === "agent" ? "Agente" : "Voce"}
              </div>
              <p>{message.text}</p>
            </div>
          ))}
          {pending ? (
            <div className="chat-bubble agent">
              <div className="bubble-role">
                <Bot size={14} />
                Agente
              </div>
              <p>Processando...</p>
            </div>
          ) : null}
        </div>

        <div className="suggestion-list">
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => setInput(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>

        <form
          className="chat-input"
          onSubmit={(event) => {
            event.preventDefault();
            runIntent(input);
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            aria-label="Comando de negocio"
            placeholder="Digite um comando, ex: crie um pedido para a Northstar de 10 notebooks"
          />
          <button type="submit" disabled={pending} title="Enviar comando">
            <Send size={20} />
          </button>
        </form>
      </aside>

      <section className="document-column">
        <div className="workspace-header">
          <div>
            <p className="eyebrow dark">workspace</p>
            <h2>Documentos e resultados</h2>
          </div>
          <TraceSummary trace={mcpTrace} />
        </div>

        <DocumentWorkspace
          analyticsResult={analyticsResult}
          audit={audit}
          conversationContext={conversationContext}
          createInvoiceAfterConfirm={createInvoiceAfterConfirm}
          documentMessage={documentMessage}
          executionPlan={executionPlan}
          invoice={invoice}
          mcpTrace={mcpTrace}
          order={order}
          pending={pending}
          preview={preview}
          setCreateInvoiceAfterConfirm={setCreateInvoiceAfterConfirm}
          onConfirmPreview={confirmPreview}
        />
      </section>
    </main>
  );
}

function DocumentWorkspace({
  analyticsResult,
  audit,
  conversationContext,
  createInvoiceAfterConfirm,
  documentMessage,
  executionPlan,
  invoice,
  mcpTrace,
  order,
  pending,
  preview,
  setCreateInvoiceAfterConfirm,
  onConfirmPreview
}: {
  analyticsResult: AnalyticsResult | null;
  audit: AuditEvent[];
  conversationContext: ConversationContext;
  createInvoiceAfterConfirm: boolean;
  documentMessage: DocumentMessage | null;
  executionPlan: ExecutionPlan | null;
  invoice: ConceptInvoice | null;
  mcpTrace: McpTrace;
  order: SalesOrder | null;
  pending: boolean;
  preview: SalesOrderPreview | null;
  setCreateInvoiceAfterConfirm: (value: boolean) => void;
  onConfirmPreview: () => void;
}) {
  const hasDocument = Boolean(preview || order || invoice || analyticsResult || executionPlan || documentMessage);
  const showGenericDocument = Boolean(documentMessage && !preview && !order && !invoice && !analyticsResult && !executionPlan);

  return (
    <div className="document-scroll">
      {!hasDocument ? <EmptyDocument /> : null}
      {showGenericDocument && documentMessage ? <GenericResultDocument document={documentMessage} /> : null}
      {executionPlan ? <ExecutionPlanDocument plan={executionPlan} /> : null}
      {preview ? (
        <SalesOrderDocument
          createInvoiceAfterConfirm={createInvoiceAfterConfirm}
          pending={pending}
          preview={preview}
          setCreateInvoiceAfterConfirm={setCreateInvoiceAfterConfirm}
          onConfirmPreview={onConfirmPreview}
        />
      ) : null}
      {order ? <ConfirmedOrderDocument invoice={invoice} order={order} /> : null}
      {analyticsResult ? <ReportDocument result={analyticsResult} /> : null}
      <OperationalFooter audit={audit} conversationContext={conversationContext} trace={mcpTrace} />
    </div>
  );
}

function EmptyDocument() {
  return (
    <div className="empty-document">
      <FileText size={44} />
      <h3>Nenhum documento aberto</h3>
      <p>
        Envie um comando no chat. Pedidos, notas fiscais conceituais, cadastros e relatorios
        aparecem aqui em formato de documento.
      </p>
    </div>
  );
}

function GenericResultDocument({ document }: { document: DocumentMessage }) {
  const items = extractResultItems(document.text);

  return (
    <article className="document-card result-document">
      <DocumentTitle
        icon={<FileText size={20} />}
        kicker="Resultado"
        title={document.title}
        status="Concluido"
      />
      <p className="result-summary">{getResultSummary(document.text)}</p>
      {items.length > 0 ? (
        <div className="result-list">
          {items.map((item) => (
            <div key={item}>
              <span>{item}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ExecutionPlanDocument({ plan }: { plan: ExecutionPlan }) {
  return (
    <article className="document-card plan-document">
      <DocumentTitle
        icon={<Sparkles size={20} />}
        kicker="Plano"
        title="Execucao planejada"
        status={`${plan.steps.length} etapa(s)`}
      />
      <p className="result-summary">{plan.summary}</p>
      <div className="plan-step-list">
        {plan.steps.map((step, index) => (
          <div key={step.id} className={`plan-step ${step.status}`}>
            <span>{index + 1}</span>
            <div>
              <strong>{step.description}</strong>
              {step.detail ? <p>{step.detail}</p> : null}
            </div>
            <em>{formatPlanStatus(step.status)}</em>
          </div>
        ))}
      </div>
    </article>
  );
}

function SalesOrderDocument({
  createInvoiceAfterConfirm,
  pending,
  preview,
  setCreateInvoiceAfterConfirm,
  onConfirmPreview
}: {
  createInvoiceAfterConfirm: boolean;
  pending: boolean;
  preview: SalesOrderPreview;
  setCreateInvoiceAfterConfirm: (value: boolean) => void;
  onConfirmPreview: () => void;
}) {
  const blocked = preview.warnings.length > 0;

  return (
    <article className="document-card">
      <DocumentTitle
        icon={<FileText size={20} />}
        kicker="Previa"
        title="Pedido de venda"
        status={blocked ? "Revisao necessaria" : "Aguardando confirmacao"}
      />

      {blocked ? (
        <div className="warning-box">
          <AlertTriangle size={18} />
          <div>
            <strong>Confirmacao bloqueada</strong>
            {preview.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </div>
      ) : null}

      <div className="document-grid">
        <Metric label="Cliente" value={preview.customer.name} />
        <Metric label="CNPJ" value={preview.customer.taxId} />
        <Metric label="Cidade" value={preview.customer.city} />
      </div>

      <LinesTable lines={preview.lines} />

      <div className="document-total">
        <label className="invoice-toggle">
          <input
            checked={createInvoiceAfterConfirm}
            onChange={(event) => setCreateInvoiceAfterConfirm(event.target.checked)}
            type="checkbox"
          />
          Gerar nota fiscal conceitual apos confirmar
        </label>
        <div>
          <span>Subtotal</span>
          <strong>{money(preview.subtotal)}</strong>
        </div>
      </div>

      <div className="document-actions">
        <button type="button" className="primary-action" disabled={pending || blocked} onClick={onConfirmPreview}>
          <Check size={18} />
          Confirmar pedido
        </button>
      </div>
    </article>
  );
}

function ConfirmedOrderDocument({ invoice, order }: { invoice: ConceptInvoice | null; order: SalesOrder }) {
  return (
    <article className="document-card">
      <DocumentTitle
        icon={<FileText size={20} />}
        kicker="Confirmado"
        title="Pedido de venda"
        status={order.status}
      />
      <div className="document-grid">
        <Metric label="Pedido" value={order.id} />
        <Metric label="Cliente" value={order.customer.name} />
        <Metric label="Criado em" value={formatDate(order.createdAt)} />
      </div>
      <LinesTable lines={order.lines} />
      <div className="document-total compact">
        <div>
          <span>Total</span>
          <strong>{money(order.subtotal)}</strong>
        </div>
      </div>
      {invoice ? <InvoiceDocument invoice={invoice} /> : null}
    </article>
  );
}

function InvoiceDocument({ invoice }: { invoice: ConceptInvoice }) {
  return (
    <div className="invoice-card">
      <DocumentTitle
        icon={<ReceiptText size={20} />}
        kicker="Documento fiscal"
        title="Nota fiscal conceitual"
        status={invoice.id}
      />
      <div className="document-grid">
        <Metric label="Cliente" value={invoice.customerName} />
        <Metric label="Pedido" value={invoice.salesOrderId} />
        <Metric label="Emissao" value={formatDate(invoice.issuedAt)} />
      </div>
      <div className="document-total compact">
        <div>
          <span>Valor</span>
          <strong>{money(invoice.amount)}</strong>
        </div>
      </div>
      <p className="fine-print">{invoice.disclaimer}</p>
    </div>
  );
}

function ReportDocument({ result }: { result: AnalyticsResult }) {
  const filters = result.query.filters.length
    ? result.query.filters.map((filter) => `${filter.label}: ${filter.value}`).join(" | ")
    : "sem filtros";
  const rows = result.rows.length
    ? result.rows
    : [{ label: "Sem dados detalhados", value: 0 }];

  return (
    <article className="document-card spreadsheet-report">
      <DocumentTitle
        icon={<Activity size={20} />}
        kicker="Relatorio"
        title={result.label}
        status={result.query.dataSource}
      />

      <div className="spreadsheet-toolbar">
        <div>
          <span>Valor consolidado</span>
          <strong>{formatAnalyticsValue(result)}</strong>
        </div>
        <div>
          <span>Agrupamento</span>
          <strong>{result.query.groupBy ?? "sem agrupamento"}</strong>
        </div>
        <div>
          <span>Periodo</span>
          <strong>{result.query.dateRange}</strong>
        </div>
      </div>

      <div className="spreadsheet-meta">
        <span>Fonte: {result.query.dataSource}</span>
        <span>Capacidade: {result.query.capability}</span>
        <span>Filtros: {filters}</span>
        <span>Entidades: {result.query.entities.join(", ")}</span>
      </div>

      <div className="spreadsheet-shell" role="table" aria-label={result.label}>
        <div className="spreadsheet-row spreadsheet-head" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">Descricao</span>
          <span role="columnheader">Metrica</span>
          <span role="columnheader">Valor</span>
        </div>
        {rows.map((row, index) => (
          <div key={`${row.label}-${index}`} className="spreadsheet-row" role="row">
            <span role="cell">{index + 1}</span>
            <span role="cell">{row.label}</span>
            <span role="cell">{result.metric}</span>
            <strong role="cell">{result.rows.length ? formatAnalyticsValue(result, row.value) : "-"}</strong>
          </div>
        ))}
        <div className="spreadsheet-row spreadsheet-total" role="row">
          <span role="cell" />
          <span role="cell">Total</span>
          <span role="cell">{result.metric}</span>
          <strong role="cell">{formatAnalyticsValue(result)}</strong>
        </div>
      </div>

      <div className="spreadsheet-footnote">
        <span>{result.rows.length} linha(s)</span>
        <span>Atualizado em tempo real pelo MCP Analytics</span>
      </div>
    </article>
  );
}

function LinesTable({ lines }: { lines: SalesOrderPreview["lines"] }) {
  return (
    <div className="lines-table">
      <div className="lines-head">
        <span>Item</span>
        <span>Qtd.</span>
        <span>Unitario</span>
        <span>Total</span>
      </div>
      {lines.map((line) => (
        <div key={`${line.productId}-${line.quantity}`} className="lines-row">
          <div>
            <strong>{line.name}</strong>
            <small>{line.sku}</small>
          </div>
          <span>{line.quantity}</span>
          <span>{money(line.unitPrice)}</span>
          <strong>{money(line.total)}</strong>
        </div>
      ))}
    </div>
  );
}

function DocumentTitle({
  icon,
  kicker,
  status,
  title
}: {
  icon: React.ReactNode;
  kicker: string;
  status: string;
  title: string;
}) {
  return (
    <div className="document-title">
      <div className="document-title-icon">{icon}</div>
      <div>
        <p>{kicker}</p>
        <h3>{title}</h3>
      </div>
      <span>{status}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TraceSummary({ trace }: { trace: McpTrace }) {
  const failures = trace.filter((entry) => entry.status === "error").length;
  return (
    <div className="trace-summary">
      <Activity size={15} />
      {trace.length} MCP calls
      {failures ? `, ${failures} erro(s)` : ""}
    </div>
  );
}

function OperationalFooter({
  audit,
  conversationContext,
  trace
}: {
  audit: AuditEvent[];
  conversationContext: ConversationContext;
  trace: McpTrace;
}) {
  return (
    <div className="operational-footer">
      <details open>
        <summary>Memoria da sessao</summary>
        <div className="memory-grid">
          <Metric label="Pedido ativo" value={conversationContext.activeOrderId ?? "-"} />
          <Metric label="Nota ativa" value={conversationContext.activeInvoiceId ?? "-"} />
          <Metric label="Cliente" value={conversationContext.activeCustomer?.name ?? "-"} />
          <Metric
            label="Produtos"
            value={conversationContext.activeProducts.length
              ? conversationContext.activeProducts.map((product) => product.name).join(", ")
              : "-"}
          />
          <Metric label="Documento" value={conversationContext.lastDocumentType ?? "-"} />
          <Metric label="Pendente" value={conversationContext.pendingConfirmation} />
        </div>
      </details>
      <details>
        <summary>Execucao MCP</summary>
        {trace.length ? (
          <div className="trace-list">
            {trace.map((entry) => (
              <div key={entry.id}>
                <span>{entry.role}.{entry.tool}</span>
                <strong>{entry.status} · {entry.durationMs}ms</strong>
              </div>
            ))}
          </div>
        ) : (
          <p>Nenhuma chamada MCP registrada no ultimo comando.</p>
        )}
      </details>
      <details>
        <summary>Auditoria</summary>
        <div className="audit-list">
          {audit.slice(0, 8).map((event) => (
            <div key={event.id}>
              <span>{event.action}</span>
              <p>{event.summary}</p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function isAgentQuestion(text: string) {
  const normalized = text.toLowerCase();
  return text.includes("?")
    || normalized.includes("preciso de mais contexto")
    || normalized.includes("informe ")
    || normalized.includes("qual ")
    || normalized.includes("confirme");
}

function inferDocumentTitle(response: AgentResponse) {
  const text = response.message.text.toLowerCase();
  const firstAuditAction = response.auditEvents[0]?.action ?? "";

  if (firstAuditAction.includes("list_low_stock") || text.includes("estoque baixo")) {
    return "Diagnostico de estoque";
  }
  if (firstAuditAction.includes("create_customer") || text.includes("cliente")) {
    return "Cadastro de cliente";
  }
  if (firstAuditAction.includes("create_product") || firstAuditAction.includes("update_product") || text.includes("produto")) {
    return "Cadastro de produto";
  }
  if (firstAuditAction.includes("create_supplier") || text.includes("fornecedor")) {
    return "Cadastro de fornecedor";
  }
  if (firstAuditAction.includes("list_recent_orders") || text.includes("pedido")) {
    return "Lista de pedidos";
  }
  return "Resultado da solicitacao";
}

function getResultSummary(text: string) {
  const [summary] = text.split(":");
  return summary?.trim() || text;
}

function extractResultItems(text: string) {
  const listSegment = text.includes(":") ? text.slice(text.indexOf(":") + 1) : "";
  if (!listSegment) {
    return [];
  }

  return listSegment
    .replace(/\.\s*Sugestao:.+$/i, "")
    .replace(/\.\s*$/, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
