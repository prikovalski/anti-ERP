"use client";

import type {
  AgentResponse,
  AnalyticsResult,
  AuditEvent,
  ConceptInvoice,
  ConversationContext,
  ExecutionPlan,
  IntelligentReport,
  ManagerialReport,
  SalesOrder,
  SalesOrderPreview
} from "@anti-erp/shared";
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

type DocumentDetailResponse = {
  order?: SalesOrder | null;
  invoice?: ConceptInvoice | null;
  message?: string;
};

type McpTrace = NonNullable<AgentResponse["mcpTrace"]>;

type DocumentMessage = {
  id: string;
  text: string;
  title: string;
};

type ResultTable = {
  title: string;
  columns: string[];
  rows: string[][];
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

function UiIcon({ label, size = 16 }: { label: string; size?: number }) {
  return (
    <span aria-hidden="true" className="ui-icon" style={{ fontSize: `${size}px` }}>
      {label}
    </span>
  );
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
  const [managerialReport, setManagerialReport] = useState<ManagerialReport | null>(null);
  const [intelligentReport, setIntelligentReport] = useState<IntelligentReport | null>(null);
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan | null>(null);
  const [documentMessage, setDocumentMessage] = useState<DocumentMessage | null>(null);
  const [documentListBeforeDetail, setDocumentListBeforeDetail] = useState<DocumentMessage | null>(null);
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
      "Liste os produtos cadastrados",
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
    setManagerialReport(response.managerialReport ?? null);
    setIntelligentReport(response.intelligentReport ?? null);
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
    setManagerialReport(null);
    setIntelligentReport(null);
    setExecutionPlan(null);
    setDocumentMessage(null);
    setDocumentListBeforeDetail(null);
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

  async function openDocumentDetail(type: "order" | "invoice", id: string) {
    setPending(true);
    setDocumentListBeforeDetail(documentMessage);
    try {
      const response = await fetch(`/api/document-detail?type=${type}&id=${encodeURIComponent(id)}`);
      const payload = (await response.json()) as DocumentDetailResponse;

      if (!response.ok) {
        throw new Error(payload.message ?? "Nao consegui carregar os detalhes.");
      }

      setOrder(payload.order ?? null);
      setInvoice(payload.invoice ?? null);
      setPreview(null);
      setAnalyticsResult(null);
      setManagerialReport(null);
      setIntelligentReport(null);
      setExecutionPlan(null);
      setDocumentMessage(null);
      setLastOrderId(payload.order?.id ?? payload.invoice?.salesOrderId ?? lastOrderId);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `document_detail_error_${Date.now()}`,
          role: "agent",
          text: error instanceof Error ? error.message : "Nao consegui carregar os detalhes."
        }
      ]);
    } finally {
      setPending(false);
    }
  }

  function backToDocumentList() {
    setOrder(null);
    setInvoice(null);
    setDocumentMessage(documentListBeforeDetail);
    setDocumentListBeforeDetail(null);
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
            <UiIcon label="*" size={15} />
            {agentMode === "openrouter" ? "OpenRouter" : "LangGraph"}
          </span>
        </div>

        <div className="chat-messages" aria-live="polite">
          {messages.map((message) => (
            <div key={message.id} className={`chat-bubble ${message.role}`}>
              <div className="bubble-role">
                {message.role === "agent" ? <UiIcon label="AI" size={14} /> : <UiIcon label=">" size={14} />}
                {message.role === "agent" ? "Agente" : "Voce"}
              </div>
              <p>{message.text}</p>
            </div>
          ))}
          {pending ? (
            <div className="chat-bubble agent">
              <div className="bubble-role">
                <UiIcon label="AI" size={14} />
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
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                runIntent(input);
              }
            }}
            aria-label="Comando de negocio"
            placeholder="Digite um comando, ex: crie um pedido para a Northstar de 10 notebooks"
          />
          <button type="submit" disabled={pending} title="Enviar comando">
            <UiIcon label=">" size={20} />
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
          intelligentReport={intelligentReport}
          managerialReport={managerialReport}
          mcpTrace={mcpTrace}
          order={order}
          pending={pending}
          preview={preview}
          setCreateInvoiceAfterConfirm={setCreateInvoiceAfterConfirm}
          onConfirmPreview={confirmPreview}
          onOpenDocumentDetail={openDocumentDetail}
          onBackToList={documentListBeforeDetail ? backToDocumentList : undefined}
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
  intelligentReport,
  managerialReport,
  mcpTrace,
  order,
  pending,
  preview,
  setCreateInvoiceAfterConfirm,
  onBackToList,
  onConfirmPreview,
  onOpenDocumentDetail
}: {
  analyticsResult: AnalyticsResult | null;
  audit: AuditEvent[];
  conversationContext: ConversationContext;
  createInvoiceAfterConfirm: boolean;
  documentMessage: DocumentMessage | null;
  executionPlan: ExecutionPlan | null;
  invoice: ConceptInvoice | null;
  intelligentReport: IntelligentReport | null;
  managerialReport: ManagerialReport | null;
  mcpTrace: McpTrace;
  order: SalesOrder | null;
  pending: boolean;
  preview: SalesOrderPreview | null;
  setCreateInvoiceAfterConfirm: (value: boolean) => void;
  onBackToList?: () => void;
  onConfirmPreview: () => void;
  onOpenDocumentDetail: (type: "order" | "invoice", id: string) => void;
}) {
  const hasDocument = Boolean(preview || order || invoice || analyticsResult || managerialReport || intelligentReport || executionPlan || documentMessage);
  const showGenericDocument = Boolean(documentMessage && !preview && !order && !invoice && !analyticsResult && !managerialReport && !intelligentReport && !executionPlan);

  return (
    <div className="document-scroll">
      {!hasDocument ? <EmptyDocument /> : null}
      {showGenericDocument && documentMessage ? (
        <GenericResultDocument document={documentMessage} onOpenDocumentDetail={onOpenDocumentDetail} />
      ) : null}
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
      {order ? <ConfirmedOrderDocument invoice={invoice} order={order} onBackToList={onBackToList} /> : null}
      {!order && invoice ? <InvoiceDetailDocument invoice={invoice} onBackToList={onBackToList} /> : null}
      {intelligentReport ? <IntelligentReportDocument report={intelligentReport} /> : null}
      {managerialReport ? <ManagerialReportDocument report={managerialReport} /> : null}
      {analyticsResult ? <ReportDocument result={analyticsResult} /> : null}
      <OperationalFooter audit={audit} conversationContext={conversationContext} trace={mcpTrace} />
    </div>
  );
}

function EmptyDocument() {
  return (
    <div className="empty-document">
      <UiIcon label="DOC" size={44} />
      <h3>Nenhum documento aberto</h3>
      <p>
        Envie um comando no chat. Pedidos, notas fiscais conceituais, cadastros e relatorios
        aparecem aqui em formato de documento.
      </p>
    </div>
  );
}

function GenericResultDocument({
  document,
  onOpenDocumentDetail
}: {
  document: DocumentMessage;
  onOpenDocumentDetail: (type: "order" | "invoice", id: string) => void;
}) {
  const table = parseResultTable(document);
  const items = extractResultItems(document.text);

  return (
    <article className="document-card result-document">
      <DocumentTitle
        icon={<UiIcon label="DOC" size={20} />}
        kicker="Resultado"
        title={document.title}
        status="Concluido"
      />
      <p className="result-summary">{getResultSummary(document.text)}</p>
      {table ? (
        <ResultTableView table={table} onOpenDocumentDetail={onOpenDocumentDetail} />
      ) : items.length > 0 ? (
        <div className="result-list">
          {items.map((item, index) => (
            <div key={`${document.id}-${index}-${item}`}>
              <span>{item}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ResultTableView({
  table,
  onOpenDocumentDetail
}: {
  table: ResultTable;
  onOpenDocumentDetail: (type: "order" | "invoice", id: string) => void;
}) {
  const actionType = getResultTableActionType(table);
  const gridTemplateColumns = actionType
    ? `${buildResultTableColumns(table.columns)} 92px`
    : buildResultTableColumns(table.columns);

  return (
    <div className="result-table-shell" role="table" aria-label={table.title}>
      <div
        className="result-table-row result-table-head"
        role="row"
        style={{ gridTemplateColumns }}
      >
        {table.columns.map((column) => (
          <span key={column} role="columnheader">{column}</span>
        ))}
        {actionType ? <span role="columnheader">Acao</span> : null}
      </div>
      {table.rows.map((row, rowIndex) => {
        const documentId = row[0] ?? "";
        const openDetail = () => {
          if (actionType && documentId) {
            onOpenDocumentDetail(actionType, documentId);
          }
        };

        return (
          <div
            key={`${table.title}-${rowIndex}-${documentId || "row"}`}
            className={`result-table-row ${actionType ? "clickable" : ""}`}
            role="row"
            style={{
              gridTemplateColumns,
              cursor: actionType ? "pointer" : undefined
            }}
            tabIndex={actionType ? 0 : undefined}
            onClick={actionType ? openDetail : undefined}
            onKeyDown={(event) => {
              if (!actionType) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openDetail();
              }
            }}
          >
            {row.map((cell, cellIndex) => (
              <span
                key={`${rowIndex}-${cellIndex}`}
                role="cell"
                style={{ cursor: actionType ? "pointer" : undefined }}
                title={cell}
              >
                {cell}
              </span>
            ))}
            {actionType ? (
              <span className="result-table-action-cell" role="cell" style={{ cursor: "pointer" }}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openDetail();
                  }}
                >
                  Ver
                </button>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function getResultTableActionType(table: ResultTable): "order" | "invoice" | null {
  if (table.title === "Pedidos") {
    return "order";
  }
  if (table.title === "Notas fiscais") {
    return "invoice";
  }
  return null;
}

function ExecutionPlanDocument({ plan }: { plan: ExecutionPlan }) {
  return (
    <article className="document-card plan-document">
      <DocumentTitle
        icon={<UiIcon label="*" size={20} />}
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
        icon={<UiIcon label="DOC" size={20} />}
        kicker="Previa"
        title="Pedido de venda"
        status={blocked ? "Revisao necessaria" : "Aguardando confirmacao"}
      />

      {blocked ? (
        <div className="warning-box">
          <UiIcon label="!" size={18} />
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
          <UiIcon label="OK" size={18} />
          Confirmar pedido
        </button>
      </div>
    </article>
  );
}

function ConfirmedOrderDocument({
  invoice,
  order,
  onBackToList
}: {
  invoice: ConceptInvoice | null;
  order: SalesOrder;
  onBackToList?: () => void;
}) {
  return (
    <article className="document-card">
      {onBackToList ? (
        <button type="button" className="secondary-action back-action" onClick={onBackToList}>
          <UiIcon label="<" size={16} />
          Voltar para listagem
        </button>
      ) : null}
      <DocumentTitle
        icon={<UiIcon label="DOC" size={20} />}
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
      <DiscountSummary order={order} />
      <div className="document-total compact">
        <div>
          <span>Total</span>
          <strong>{money(order.subtotal)}</strong>
        </div>
      </div>
      {invoice ? <InvoiceDocument invoice={invoice} sourceOrder={order} /> : null}
    </article>
  );
}

function InvoiceDetailDocument({
  invoice,
  onBackToList
}: {
  invoice: ConceptInvoice;
  onBackToList?: () => void;
}) {
  return (
    <article className="document-card">
      {onBackToList ? (
        <button type="button" className="secondary-action back-action" onClick={onBackToList}>
          <UiIcon label="<" size={16} />
          Voltar para listagem
        </button>
      ) : null}
      <InvoiceDocument invoice={invoice} />
    </article>
  );
}

function InvoiceDocument({ invoice, sourceOrder }: { invoice: ConceptInvoice; sourceOrder?: SalesOrder | null }) {
  return (
    <div className="invoice-card">
      <DocumentTitle
        icon={<UiIcon label="NF" size={20} />}
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
      {sourceOrder ? <DiscountSummary order={sourceOrder} compact /> : null}
      <p className="fine-print">{invoice.disclaimer}</p>
    </div>
  );
}

function ReportDocument({ result }: { result: AnalyticsResult }) {
  const [exportingPdf, setExportingPdf] = useState(false);
  const rows = result.rows.length
    ? result.rows
    : [{ label: "Sem dados detalhados", value: 0 }];

  async function downloadPdf() {
    setExportingPdf(true);
    try {
      await downloadReportPdf(toIntelligentReportFromAnalytics(result));
    } finally {
      setExportingPdf(false);
    }
  }

  return (
    <article className="document-card spreadsheet-report">
      <div className="report-header">
        <DocumentTitle
          icon={<UiIcon label="BI" size={20} />}
          kicker="Relatorio"
          title={formatReportTitle(result.label)}
        />

        <button type="button" className="secondary-action report-pdf-action" disabled={exportingPdf} onClick={downloadPdf}>
          <UiIcon label="PDF" size={13} />
          {exportingPdf ? "Gerando..." : "Gerar PDF"}
        </button>
      </div>

      <div className="spreadsheet-toolbar">
        <div>
          <span>Valor consolidado</span>
          <strong>{formatAnalyticsValue(result)}</strong>
        </div>
        <div>
          <span>Agrupamento</span>
          <strong>{formatAnalyticsGroupBy(result.query.groupBy)}</strong>
        </div>
        <div>
          <span>Periodo</span>
          <strong>{formatReportPeriod(result.query.dateRange)}</strong>
        </div>
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
            <span role="cell">{formatMetricLabel(result.metric)}</span>
            <strong role="cell">{result.rows.length ? formatAnalyticsValue(result, row.value) : "-"}</strong>
          </div>
        ))}
        <div className="spreadsheet-row spreadsheet-total" role="row">
          <span role="cell" />
          <span role="cell">Total</span>
          <span role="cell">{formatMetricLabel(result.metric)}</span>
          <strong role="cell">{formatAnalyticsValue(result)}</strong>
        </div>
      </div>

      <div className="spreadsheet-footnote">
        <span>{result.rows.length} linha(s)</span>
      </div>
    </article>
  );
}

function ManagerialReportDocument({ report }: { report: ManagerialReport }) {
  const [exportingPdf, setExportingPdf] = useState(false);
  const rows = report.rows;

  async function downloadPdf() {
    setExportingPdf(true);
    try {
      await downloadReportPdf(toIntelligentReportFromManagerial(report));
    } finally {
      setExportingPdf(false);
    }
  }

  return (
    <article className="document-card spreadsheet-report">
      <div className="report-header">
        <DocumentTitle
          icon={<UiIcon label="BI" size={20} />}
          kicker="Relatorio gerencial"
          title={report.title}
        />

        <button type="button" className="secondary-action report-pdf-action" disabled={exportingPdf} onClick={downloadPdf}>
          <UiIcon label="PDF" size={13} />
          {exportingPdf ? "Gerando..." : "Gerar PDF"}
        </button>
      </div>

      <div className="spreadsheet-toolbar">
        <div>
          <span>Resumo</span>
          <strong>{report.summary}</strong>
        </div>
        <div>
          <span>Periodo</span>
          <strong>{formatReportPeriod(report.dateRange)}</strong>
        </div>
        <div>
          <span>Linhas</span>
          <strong>{rows.length}</strong>
        </div>
      </div>

      {report.insights.length ? (
        <div className="spreadsheet-meta">
          {report.insights.map((insight, index) => (
            <span key={`${report.kind}-insight-${index}`}>{insight}</span>
          ))}
        </div>
      ) : null}

      <div className="result-table-shell" role="table" aria-label={report.title}>
        <div
          className="result-table-row result-table-head"
          role="row"
          style={{ gridTemplateColumns: buildResultTableColumns(report.columns.length) }}
        >
          {report.columns.map((column) => (
            <span key={column} role="columnheader">{formatColumnLabel(column)}</span>
          ))}
        </div>
        {rows.map((row, rowIndex) => (
          <div
            key={`${report.kind}-${rowIndex}`}
            className="result-table-row"
            role="row"
            style={{ gridTemplateColumns: buildResultTableColumns(report.columns.length) }}
          >
            {report.columns.map((column) => (
              <span key={`${rowIndex}-${column}`} role="cell">{formatReportCell(row[column], column)}</span>
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}

function IntelligentReportDocument({ report }: { report: IntelligentReport }) {
  const [exportingPdf, setExportingPdf] = useState(false);
  const filters = report.plan.filters.length
    ? report.plan.filters.map((filter) => `${filter.label}: ${filter.value}`).join(" | ")
    : "sem filtros";

  async function downloadPdf() {
    setExportingPdf(true);
    try {
      const response = await fetch("/api/reports/intelligent/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report })
      });
      if (!response.ok) {
        throw new Error("PDF generation failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = buildReportFilename(report);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExportingPdf(false);
    }
  }

  return (
    <article className="document-card spreadsheet-report">
      <div className="report-header">
        <DocumentTitle
          icon={<UiIcon label="BI" size={20} />}
          kicker="Relatorio inteligente"
          title={report.title}
          status={report.dataSource}
        />

        <button type="button" className="secondary-action report-pdf-action" disabled={exportingPdf} onClick={downloadPdf}>
          <UiIcon label="PDF" size={13} />
          {exportingPdf ? "Gerando..." : "Gerar PDF"}
        </button>
      </div>

      <div className="report-summary">
        <span>Resumo executivo</span>
        <p>{report.summary}</p>
      </div>

      <div className="report-kpis">
        <div>
          <span>Periodo</span>
          <strong>{formatReportDateRange(report.plan.dateRange)}</strong>
        </div>
        <div>
          <span>Granularidade</span>
          <strong>{formatReportGrain(report.plan.grain)}</strong>
        </div>
        <div>
          <span>Linhas</span>
          <strong>{report.rows.length}</strong>
        </div>
        <div>
          <span>Indicador</span>
          <strong>{report.plan.metric}</strong>
        </div>
      </div>

      <div className="report-insights">
        {report.executiveSummary.map((item, index) => (
          <span key={`executive-${index}`}>{item}</span>
        ))}
        {[...report.insights, ...report.recommendations].map((item, index) => (
          <span key={`insight-${index}`}>{item}</span>
        ))}
      </div>

      <div className="report-context">
        <span>Filtros: {filters}</span>
        <span>Entidades: {report.plan.entities.join(", ")}</span>
      </div>

      {report.rows.length ? (
        <div className="report-table-block">
          <h3>Dados detalhados</h3>
          <div className="result-table-shell report-result-table" role="table" aria-label={report.title}>
            <div
              className="result-table-row result-table-head"
              role="row"
              style={{ gridTemplateColumns: buildResultTableColumns(report.columns) }}
            >
              {report.columns.map((column) => (
                <span key={column} role="columnheader">{formatColumnLabel(column)}</span>
              ))}
            </div>
            {report.rows.map((row, rowIndex) => (
              <div
                key={`intelligent-report-${rowIndex}`}
                className="result-table-row"
                role="row"
                style={{ gridTemplateColumns: buildResultTableColumns(report.columns) }}
              >
                {report.columns.map((column) => (
                  <span key={`${rowIndex}-${column}`} role="cell">{formatReportCell(row[column], column)}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {report.sql ? (
        <details className="sql-disclosure">
          <summary>Consulta SQL somente leitura</summary>
          <pre>{report.sql}</pre>
        </details>
      ) : null}
    </article>
  );
}

function buildReportFilename(report: IntelligentReport) {
  const slug = report.title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);

  return `${slug || "relatorio-gerencial"}-${report.generatedAt.slice(0, 10)}.pdf`;
}

async function downloadReportPdf(report: IntelligentReport) {
  const response = await fetch("/api/reports/intelligent/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report })
  });
  if (!response.ok) {
    throw new Error("PDF generation failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildReportFilename(report);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toIntelligentReportFromAnalytics(result: AnalyticsResult): IntelligentReport {
  const columns = ["descricao", "metrica", "valor"];
  const rows = result.rows.map((row) => ({
    descricao: row.label,
    metrica: formatMetricLabel(result.metric),
    valor: row.value
  }));
  const title = formatReportTitle(result.label);

  return {
    title,
    summary: `${title} com valor consolidado de ${formatAnalyticsValue(result)}.`,
    executiveSummary: [
      `O relatorio consolidou ${result.rows.length} linha(s) no periodo ${formatReportPeriod(result.query.dateRange)}.`,
      result.rows[0] ? `${result.rows[0].label} aparece como principal destaque.` : "Nao ha linhas detalhadas para o periodo."
    ],
    sql: "",
    columns,
    rows,
    insights: [],
    recommendations: [],
    plan: {
      question: result.label,
      title,
      metric: formatMetricLabel(result.metric),
      grain: result.query.groupBy === "customer" ? "customer" : result.query.groupBy === "product" ? "product" : "summary",
      dateRange: result.query.dateRange,
      entities: result.query.entities,
      filters: result.query.filters,
      needsClarification: false,
      clarificationQuestion: null,
      charts: [{ type: "bar", title, xKey: "descricao", yKey: "valor" }]
    },
    dataSource: result.query.dataSource === "postgres" ? "postgres" : "demo-memory",
    generatedAt: new Date().toISOString()
  };
}

function toIntelligentReportFromManagerial(report: ManagerialReport): IntelligentReport {
  return {
    title: report.title,
    summary: report.summary,
    executiveSummary: report.insights.length ? report.insights : [report.summary],
    sql: "",
    columns: report.columns,
    rows: report.rows,
    insights: report.insights,
    recommendations: [],
    plan: {
      question: report.title,
      title: report.title,
      metric: report.kind,
      grain: "summary",
      dateRange: report.dateRange,
      entities: report.query.entities,
      filters: report.query.filters,
      needsClarification: false,
      clarificationQuestion: null,
      charts: [{ type: "table", title: report.title, xKey: null, yKey: null }]
    },
    dataSource: report.dataSource === "postgres" ? "postgres" : "demo-memory",
    generatedAt: new Date().toISOString()
  };
}

function formatReportTitle(value: string) {
  return value
    .replace(/units sold/gi, "Unidades vendidas")
    .replace(/sales month to date/gi, "no mes atual")
    .replace(/month to date/gi, "mes atual")
    .replace(/\bfor no mes atual\b/gi, "no mes atual")
    .replace(/\bfor\b/gi, "por")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatMetricLabel(value: string) {
  const labels: Record<string, string> = {
    units_sold: "Unidades vendidas",
    revenue: "Faturamento",
    orders: "Pedidos"
  };
  return labels[value] ?? value.replace(/_/g, " ");
}

function formatAnalyticsGroupBy(value: AnalyticsResult["query"]["groupBy"]) {
  if (value === "product") return "Produto";
  if (value === "customer") return "Cliente";
  if (value === "day") return "Dia";
  return "Sem agrupamento";
}

function formatReportPeriod(value: AnalyticsResult["query"]["dateRange"]) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === "today") {
    return formatDateOnly(end);
  }
  if (value === "last_7_days") {
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    return `${formatDateOnly(start)} a ${formatDateOnly(end)}`;
  }
  if (value === "last_30_days") {
    const start = new Date(end);
    start.setDate(end.getDate() - 29);
    return `${formatDateOnly(start)} a ${formatDateOnly(end)}`;
  }
  if (value === "month_to_date") {
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return `${formatDateOnly(start)} a ${formatDateOnly(end)}`;
  }
  return "Todo o historico";
}

function formatDateOnly(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(value);
}

function formatReportDateRange(value: IntelligentReport["plan"]["dateRange"]) {
  const labels: Record<IntelligentReport["plan"]["dateRange"], string> = {
    today: "Hoje",
    last_7_days: "Ultimos 7 dias",
    last_30_days: "Ultimos 30 dias",
    month_to_date: "Mes atual",
    all_time: "Todo o historico"
  };
  return labels[value];
}

function formatReportGrain(value: IntelligentReport["plan"]["grain"]) {
  const labels: Record<IntelligentReport["plan"]["grain"], string> = {
    summary: "Resumo",
    day: "Dia",
    customer: "Cliente",
    product: "Produto",
    invoice: "Nota fiscal",
    order: "Pedido"
  };
  return labels[value];
}

function formatColumnLabel(value: string) {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatReportCell(value: string | number | boolean | null | undefined, column?: string) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "boolean") {
    return value ? "Sim" : "Nao";
  }
  if (typeof value === "number") {
    if (column && /faturamento|valor|preco|margem|receita/i.test(column)) {
      return money(value);
    }
    return Number.isInteger(value) ? String(value) : money(value);
  }
  return value;
}

function DiscountSummary({ order, compact = false }: { order: SalesOrder; compact?: boolean }) {
  const originalSubtotal = calculateOriginalSubtotal(order);
  const discount = Math.max(0, originalSubtotal - order.subtotal);
  if (discount <= 0.004) {
    return null;
  }
  const percentage = originalSubtotal > 0 ? (discount / originalSubtotal) * 100 : 0;

  return (
    <div className={`discount-summary ${compact ? "compact" : ""}`}>
      <div>
        <span>Subtotal original sem desconto</span>
        <strong>{money(originalSubtotal)}</strong>
      </div>
      <div>
        <span>Desconto acumulado sobre o subtotal original</span>
        <strong>{money(discount)}</strong>
        <small>{formatPercent(percentage)}</small>
      </div>
      <div>
        <span>Total liquido com desconto</span>
        <strong>{money(order.subtotal)}</strong>
      </div>
      <p>O desconto acumulado e a diferenca entre o subtotal original e o total liquido atual do pedido.</p>
    </div>
  );
}

function LinesTable({ lines }: { lines: SalesOrderPreview["lines"] }) {
  return (
    <div className="lines-table">
      <div className="lines-head">
        <span>Item</span>
        <span>Qtd.</span>
        <span>Unitario</span>
        <span>Total liquido</span>
      </div>
      {lines.map((line, index) => (
        <div key={`${line.productId}-${line.quantity}-${index}`} className="lines-row">
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

function calculateOriginalSubtotal(order: SalesOrder) {
  return roundMoney(order.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(value)}%`;
}

function DocumentTitle({
  icon,
  kicker,
  status,
  title
}: {
  icon: React.ReactNode;
  kicker: string;
  status?: string;
  title: string;
}) {
  return (
    <div className="document-title">
      <div className="document-title-icon">{icon}</div>
      <div>
        <p>{kicker}</p>
        <h3>{title}</h3>
      </div>
      {status ? <span>{status}</span> : null}
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
      <UiIcon label="BI" size={15} />
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
  if (firstAuditAction.includes("list_inventory_position") || text.startsWith("estoque atual")) {
    return "Estoque atual";
  }
  if (firstAuditAction.includes("list_inventory_movements") || text.includes("historico de estoque")) {
    return "Historico de estoque";
  }
  if (firstAuditAction.includes("list_concept_invoices") || mentionsInvoice(text)) {
    return "Lista de notas fiscais";
  }
  if (firstAuditAction.includes("list_sales_orders") || firstAuditAction.includes("list_recent_orders") || text.includes("pedido")) {
    return "Lista de pedidos";
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
  return "Resultado da solicitacao";
}

function mentionsInvoice(text: string) {
  return /\b(nota|notas|nf|nfs)\b/.test(text)
    || text.includes("nota(s) fiscal")
    || text.includes("nota fiscal")
    || text.includes("nota(s) fiscal(is)");
}

function getResultSummary(text: string) {
  const [summary] = text.split(/[:\n]/);
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

function parseResultTable(document: DocumentMessage): ResultTable | null {
  if (document.title === "Lista de pedidos") {
    return parseSalesOrderList(document.text);
  }
  if (document.title === "Cadastro de cliente" && document.text.toLowerCase().includes("cliente(s):")) {
    return parseCustomerList(document.text);
  }
  if (document.title === "Cadastro de produto" && document.text.toLowerCase().includes("produto(s):")) {
    return parseProductList(document.text);
  }
  if (document.title === "Diagnostico de estoque") {
    return parseLowStockProductList(document.text);
  }
  if (document.title === "Estoque atual") {
    return parseInventoryPositionList(document.text);
  }
  if (document.title === "Lista de notas fiscais") {
    return parseInvoiceList(document.text);
  }
  if (document.title === "Historico de estoque") {
    return parseInventoryMovementList(document.text);
  }
  return null;
}

function parseSalesOrderList(text: string): ResultTable | null {
  const items = extractSemicolonItems(text);
  const rows = items
    .map(parseSalesOrderListItem)
    .filter((row): row is string[] => Boolean(row));

  if (!rows.length) {
    return null;
  }
  return {
    title: "Pedidos",
    columns: ["Pedido", "Criado em", "Cliente", "Status", "Itens", "Total"],
    rows
  };
}

function parseSalesOrderListItem(item: string) {
  if (item.includes("|")) {
    return parsePipedSalesOrderListItem(item);
  }

  const orderMatch = item.match(/^(SO-\d+)\s+para\s+/i);
  if (!orderMatch?.[1]) {
    return null;
  }

  const orderId = orderMatch[1];
  const rest = item.slice(orderMatch[0].length);
  const detailsStart = rest.lastIndexOf(" (");
  const detailsEnd = rest.endsWith(")") ? rest.length - 1 : -1;
  if (detailsStart < 0 || detailsEnd < detailsStart) {
    return null;
  }

  const customer = rest.slice(0, detailsStart).trim();
  const details = rest.slice(detailsStart + 2, detailsEnd);
  const detailParts = details.split(",").map((part) => part.trim());
  const total = detailParts.find((part) => /^total\s+/i.test(part))?.replace(/^total\s+/i, "") ?? "-";
  const status = detailParts.find((part) => /^(confirmado|cancelado|rascunho)$/i.test(part)) ?? "-";
  const itemCount = detailParts.find((part) => /item/i.test(part)) ?? "-";

  return [orderId, "-", customer || "-", status, itemCount, total];
}

function parsePipedSalesOrderListItem(item: string) {
  const parts = item.split("|").map((part) => part.trim()).filter(Boolean);
  const orderId = parts[0];
  if (!orderId?.match(/^SO-\d+$/i)) {
    return null;
  }

  return [
    orderId,
    readLabeledListPart(parts, /^criado em\s+/i),
    readLabeledListPart(parts, /^cliente\s+/i),
    readLabeledListPart(parts, /^status\s+/i),
    readLabeledListPart(parts, /^itens?\s+/i),
    readLabeledListPart(parts, /^total\s+/i)
  ];
}

function readLabeledListPart(parts: string[], label: RegExp) {
  return parts.find((part) => label.test(part))?.replace(label, "").trim() || "-";
}

function parseCustomerList(text: string): ResultTable | null {
  const items = extractSemicolonItems(text);
  const rows = items
    .map((item) => {
      const match = item.match(/^(.+?)\s+\((.+?),\s*(ativo|bloqueado)\)$/i);
      if (!match) {
        return null;
      }
      return [match[1] ?? "-", match[2] ?? "-", match[3] ?? "-"];
    })
    .filter((row): row is string[] => Boolean(row));

  if (!rows.length) {
    return null;
  }
  return {
    title: "Clientes",
    columns: ["Cliente", "Cidade", "Status"],
    rows
  };
}

function parseProductList(text: string): ResultTable | null {
  const items = extractSemicolonItems(text);
  const rows = items
    .map((item) => {
      const match = item.match(/^(.+?)\s+\((.+?)\)$/i);
      if (!match) {
        return null;
      }
      const details = (match[2] ?? "").split(",").map((part) => part.trim());
      const sku = details[0] ?? "-";
      const status = details.find((part) => /^(ativo|inativo)$/i.test(part)) ?? "-";
      const available = details.find((part) => /^disponivel\s+/i.test(part))?.replace(/^disponivel\s+/i, "") ?? "-";
      const reserved = details.find((part) => /^reservado\s+/i.test(part))?.replace(/^reservado\s+/i, "") ?? "-";
      const price = details.find((part) => /^preco\s+/i.test(part))?.replace(/^preco\s+/i, "") ?? "-";
      return [match[1] ?? "-", sku, status, available, reserved, price];
    })
    .filter((row): row is string[] => Boolean(row));

  if (!rows.length) {
    return null;
  }
  return {
    title: "Produtos",
    columns: ["Produto", "SKU", "Status", "Disponivel", "Reservado", "Preco"],
    rows
  };
}

function parseLowStockProductList(text: string): ResultTable | null {
  const items = extractSemicolonItems(text);
  const rows = items
    .map((item) => {
      const match = item.match(/^(.+?)\s+\((.+?)\)$/i);
      if (!match) {
        return null;
      }
      const details = (match[2] ?? "").split(",").map((part) => part.trim());
      const sku = details[0] ?? "-";
      const available = details.find((part) => /^disponivel\s+/i.test(part))?.replace(/^disponivel\s+/i, "") ?? "-";
      const reserved = details.find((part) => /^reservado\s+/i.test(part))?.replace(/^reservado\s+/i, "") ?? "-";
      return [match[1] ?? "-", sku, available, reserved];
    })
    .filter((row): row is string[] => Boolean(row));

  if (!rows.length) {
    return null;
  }
  return {
    title: "Produtos com estoque baixo",
    columns: ["Produto", "SKU", "Disponivel", "Reservado"],
    rows
  };
}

function parseInvoiceList(text: string): ResultTable | null {
  const items = extractSemicolonItems(text);
  const rows = items
    .map((item) => {
      if (item.includes("|")) {
        return parsePipedInvoiceListItem(item);
      }

      const match = item.match(/^(CI-\d+)\s+do\s+pedido\s+(SO-\d+)\s+para\s+(.+?)\s+\((.+?)\)$/i);
      if (!match) {
        return null;
      }
      const details = (match[4] ?? "").split(",").map((part) => part.trim());
      const status = details[0] ?? "-";
      const amount = details.find((part) => /^valor\s+/i.test(part))?.replace(/^valor\s+/i, "") ?? "-";
      const changed = details.find((part) => /pedido/i.test(part)) ?? "-";
      return [match[1] ?? "-", "-", match[2] ?? "-", match[3] ?? "-", status, amount, changed];
    })
    .filter((row): row is string[] => Boolean(row));

  if (!rows.length) {
    return null;
  }
  return {
    title: "Notas fiscais",
    columns: ["NF", "Emissao", "Pedido", "Cliente", "Status", "Valor", "Situacao"],
    rows
  };
}

function parsePipedInvoiceListItem(item: string) {
  const parts = item.split("|").map((part) => part.trim()).filter(Boolean);
  const invoiceId = parts[0];
  if (!invoiceId?.match(/^CI-\d+$/i)) {
    return null;
  }

  return [
    invoiceId,
    readLabeledListPart(parts, /^emitida em\s+/i),
    readLabeledListPart(parts, /^pedido\s+/i),
    readLabeledListPart(parts, /^cliente\s+/i),
    readLabeledListPart(parts, /^status\s+/i),
    readLabeledListPart(parts, /^valor\s+/i),
    parts.find((part) => /^pedido\s+(?:alterado|sem)/i.test(part)) ?? "-"
  ];
}

function parseInventoryMovementList(text: string): ResultTable | null {
  const items = extractSemicolonItems(text);
  const rows = items
    .map((item) => {
      const parts = item.split("|").map((part) => part.trim());
      if (parts.length < 8) {
        return null;
      }
      return [parts[0] ?? "-", parts[1] ?? "-", parts[2] ?? "-", parts[3]?.replace(/^qtd\s+/i, "") ?? "-", parts[4]?.replace(/^disponivel\s+/i, "") ?? "-", parts[5]?.replace(/^reservado\s+/i, "") ?? "-", parts[6] ?? "-", parts[7] ?? "-"];
    })
    .filter((row): row is string[] => Boolean(row));

  if (!rows.length) {
    return null;
  }
  return {
    title: "Movimentacoes de estoque",
    columns: ["Data", "Produto", "Tipo", "Qtd", "Disponivel", "Reservado", "Pedido", "Motivo"],
    rows
  };
}

function parseInventoryPositionList(text: string): ResultTable | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dataLines = lines.filter((line) =>
    line.includes("|")
    && !/^produto\s*\|\s*quantidade\s+disponivel$/i.test(line)
  );
  const rows = dataLines
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
    .map((parts) => [parts[0] ?? "-", parts[1] ?? "-"]);

  if (!rows.length) {
    return null;
  }
  return {
    title: "Estoque atual",
    columns: ["Produto", "Quantidade disponivel"],
    rows
  };
}

function extractSemicolonItems(text: string) {
  const listSegment = text.includes(":") ? text.slice(text.indexOf(":") + 1) : "";
  return listSegment
    .replace(/\.\s*$/, "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildResultTableColumns(columns: number | string[]) {
  if (Array.isArray(columns) && columns.join("|") === "produto|quantidade|faturamento|pedidos") {
    return "minmax(260px, 1fr) 130px 170px 120px";
  }
  if (Array.isArray(columns) && columns.join("|") === "cliente|pedidos|faturamento|ultimo_pedido") {
    return "minmax(260px, 1fr) 120px 170px 150px";
  }
  if (Array.isArray(columns) && columns.join("|") === "Pedido|Criado em|Cliente|Status|Itens|Total") {
    return "130px 130px minmax(220px, 1fr) 120px 100px 150px";
  }
  if (Array.isArray(columns) && columns.join("|") === "NF|Emissao|Pedido|Cliente|Status|Valor|Situacao") {
    return "120px 130px 120px minmax(220px, 1fr) 120px 150px 210px";
  }
  if (Array.isArray(columns) && columns.join("|") === "Produto|Quantidade disponivel") {
    return "minmax(260px, 1fr) 170px";
  }

  const count = Array.isArray(columns) ? columns.length : columns;
  if (count === 8) {
    return "150px minmax(180px, 1fr) 150px 80px 140px 140px 110px minmax(220px, 1fr)";
  }
  if (count === 5) {
    return "130px minmax(220px, 1fr) 130px 120px 150px";
  }
  if (count === 6) {
    return "120px 120px minmax(220px, 1fr) 130px 150px 210px";
  }
  if (count === 4) {
    return "minmax(220px, 1fr) minmax(180px, 1fr) 120px 120px";
  }
  if (count === 3) {
    return "minmax(240px, 1fr) 180px 130px";
  }
  return `repeat(${count}, minmax(140px, 1fr))`;
}
