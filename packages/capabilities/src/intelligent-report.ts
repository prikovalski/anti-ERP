import type {
  AnalyticsDateRange,
  AnalyticsEntity,
  AnalyticsFilter,
  IntelligentReport,
  IntelligentReportChart,
  IntelligentReportPlan,
} from "@anti-erp/shared";

type ReportValue = string | number | boolean | null;

type SqlPlan = {
  sql: string;
  metric: string;
  title: string;
  grain: IntelligentReportPlan["grain"];
  entities: AnalyticsEntity[];
  filters: AnalyticsFilter[];
  charts: IntelligentReportChart[];
  recommendations: string[];
};

export type IntelligentReportQueryRunner = (sql: string) => Promise<Array<Record<string, ReportValue>>>;

export const managerialSemanticCatalog = [
  {
    entity: "sales_orders",
    table: "\"SalesOrder\"",
    businessName: "pedidos de venda",
    description: "Pedidos criados pelo anti-ERP. Use pedidos confirmados para vendas operacionais."
  },
  {
    entity: "sales_order_lines",
    table: "\"SalesOrderLine\"",
    businessName: "itens de pedido",
    description: "Itens, quantidades, precos e totais dos pedidos de venda."
  },
  {
    entity: "concept_invoices",
    table: "\"ConceptInvoice\"",
    businessName: "notas fiscais conceituais",
    description: "Notas emitidas, canceladas ou reemitidas a partir de pedidos."
  },
  {
    entity: "customers",
    table: "\"Customer\"",
    businessName: "clientes",
    description: "Clientes cadastrados e usados em pedidos e notas."
  },
  {
    entity: "products",
    table: "\"Product\"",
    businessName: "produtos",
    description: "Produtos, preco e saldo de estoque."
  }
] as const;

export async function queryIntelligentReportFromSql(input: {
  question: string;
  dataSource: "postgres" | "demo-memory";
  runQuery: IntelligentReportQueryRunner;
}) {
  const plan = planIntelligentReport(input.question);
  if (plan.needsClarification) {
    return buildClarificationReport(plan, input.dataSource);
  }

  const sqlPlan = buildSqlPlan(plan);
  validateReadonlySql(sqlPlan.sql);
  const rows = await input.runQuery(sqlPlan.sql);
  const columns = rows[0] ? Object.keys(rows[0]) : inferEmptyColumns(plan);
  const total = rows.length;

  return {
    title: sqlPlan.title,
    summary: summarizeRows(sqlPlan.metric, rows),
    executiveSummary: buildExecutiveSummary(sqlPlan.metric, rows, total),
    sql: sqlPlan.sql,
    columns,
    rows,
    insights: buildInsights(sqlPlan.metric, rows),
    recommendations: sqlPlan.recommendations,
    plan: {
      ...plan,
      title: sqlPlan.title,
      metric: sqlPlan.metric,
      entities: sqlPlan.entities,
      filters: sqlPlan.filters,
      charts: sqlPlan.charts
    },
    dataSource: input.dataSource,
    generatedAt: new Date().toISOString()
  } satisfies IntelligentReport;
}

export function planIntelligentReport(question: string): IntelligentReportPlan {
  const normalized = normalize(question);
  const dateRange = inferDateRange(normalized);
  const grain = inferGrain(normalized);
  const metric = inferMetric(normalized);
  const needsClarification = metric === "generic";

  return {
    question,
    title: "Relatorio gerencial inteligente",
    metric,
    grain,
    dateRange,
    entities: [],
    filters: [{ label: "periodo", value: translateDateRange(dateRange) }],
    needsClarification,
    clarificationQuestion: needsClarification
      ? "Qual indicador gerencial voce quer analisar: faturamento, vendas, notas emitidas, clientes, produtos ou estoque?"
      : null,
    charts: []
  };
}

export function validateReadonlySql(sql: string) {
  const normalized = sql.trim().toLowerCase();
  if (!normalized.startsWith("select")) {
    throw new Error("Only SELECT statements are allowed for intelligent reports.");
  }
  if (/[;]/.test(normalized.replace(/;\s*$/, ""))) {
    throw new Error("Multiple SQL statements are not allowed.");
  }
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|execute)\b/.test(normalized)) {
    throw new Error("Unsafe SQL keyword detected.");
  }
}

function buildSqlPlan(plan: IntelligentReportPlan): SqlPlan {
  if (plan.metric === "invoices") {
    return buildInvoicesSqlPlan(plan);
  }
  if (plan.metric === "stock") {
    return buildStockSqlPlan(plan);
  }
  if (plan.grain === "customer") {
    return buildSalesByCustomerSqlPlan(plan);
  }
  if (plan.grain === "day") {
    return buildSalesByDaySqlPlan(plan);
  }
  return buildSalesByProductSqlPlan(plan);
}

function buildSalesByProductSqlPlan(plan: IntelligentReportPlan): SqlPlan {
  return {
    title: `Vendas por produto - ${translateDateRange(plan.dateRange)}`,
    metric: "vendas por produto",
    grain: "product",
    entities: ["sales_orders", "sales_order_lines", "products"],
    filters: plan.filters,
    charts: [{ type: "bar", title: "Faturamento por produto", xKey: "produto", yKey: "faturamento" }],
    recommendations: ["Investigue produtos com alta quantidade e baixa participacao no faturamento para revisar preco e margem."],
    sql: `
SELECT
  p.name AS produto,
  SUM(sol.quantity)::int AS quantidade,
  ROUND(SUM(sol."totalCents") / 100.0, 2)::float AS faturamento,
  COUNT(DISTINCT so.id)::int AS pedidos
FROM "SalesOrder" so
JOIN "SalesOrderLine" sol ON sol."salesOrderId" = so.id
JOIN "Product" p ON p.id = sol."productId"
WHERE so.status = 'confirmed' ${datePredicate("so.\"createdAt\"", plan.dateRange)}
GROUP BY p.name
ORDER BY faturamento DESC
LIMIT 25`.trim()
  };
}

function buildSalesByCustomerSqlPlan(plan: IntelligentReportPlan): SqlPlan {
  return {
    title: `Vendas por cliente - ${translateDateRange(plan.dateRange)}`,
    metric: "vendas por cliente",
    grain: "customer",
    entities: ["sales_orders", "customers"],
    filters: plan.filters,
    charts: [{ type: "bar", title: "Faturamento por cliente", xKey: "cliente", yKey: "faturamento" }],
    recommendations: ["Use o ranking para priorizar relacionamento comercial e identificar concentracao de receita."],
    sql: `
SELECT
  c.name AS cliente,
  COUNT(DISTINCT so.id)::int AS pedidos,
  ROUND(SUM(sol."totalCents") / 100.0, 2)::float AS faturamento,
  MAX(so."createdAt")::date::text AS ultimo_pedido
FROM "SalesOrder" so
JOIN "Customer" c ON c.id = so."customerId"
JOIN "SalesOrderLine" sol ON sol."salesOrderId" = so.id
WHERE so.status = 'confirmed' ${datePredicate("so.\"createdAt\"", plan.dateRange)}
GROUP BY c.name
ORDER BY faturamento DESC
LIMIT 25`.trim()
  };
}

function buildSalesByDaySqlPlan(plan: IntelligentReportPlan): SqlPlan {
  return {
    title: `Evolucao de vendas - ${translateDateRange(plan.dateRange)}`,
    metric: "evolucao de vendas",
    grain: "day",
    entities: ["sales_orders", "sales_order_lines"],
    filters: plan.filters,
    charts: [{ type: "line", title: "Faturamento diario", xKey: "dia", yKey: "faturamento" }],
    recommendations: ["Verifique dias de pico e queda para relacionar com campanhas, ruptura de estoque ou sazonalidade."],
    sql: `
SELECT
  so."createdAt"::date::text AS dia,
  COUNT(DISTINCT so.id)::int AS pedidos,
  SUM(sol.quantity)::int AS quantidade,
  ROUND(SUM(sol."totalCents") / 100.0, 2)::float AS faturamento
FROM "SalesOrder" so
JOIN "SalesOrderLine" sol ON sol."salesOrderId" = so.id
WHERE so.status = 'confirmed' ${datePredicate("so.\"createdAt\"", plan.dateRange)}
GROUP BY so."createdAt"::date
ORDER BY dia ASC
LIMIT 90`.trim()
  };
}

function buildInvoicesSqlPlan(plan: IntelligentReportPlan): SqlPlan {
  return {
    title: `Notas fiscais emitidas - ${translateDateRange(plan.dateRange)}`,
    metric: "notas emitidas",
    grain: "invoice",
    entities: ["concept_invoices", "sales_orders", "customers"],
    filters: [{ label: "status", value: "emitida" }, ...plan.filters],
    charts: [{ type: "bar", title: "Valor emitido por cliente", xKey: "cliente", yKey: "valor" }],
    recommendations: ["Compare notas emitidas com pedidos confirmados para localizar diferencas entre venda e faturamento."],
    sql: `
SELECT
  ci.id AS nota,
  ci."issuedAt"::date::text AS emissao,
  ci."salesOrderId" AS pedido,
  ci."customerName" AS cliente,
  ci.status AS status,
  ROUND(ci."amountCents" / 100.0, 2)::float AS valor
FROM "ConceptInvoice" ci
WHERE ci.status = 'issued' ${datePredicate("ci.\"issuedAt\"", plan.dateRange)}
ORDER BY ci."issuedAt" DESC
LIMIT 50`.trim()
  };
}

function buildStockSqlPlan(plan: IntelligentReportPlan): SqlPlan {
  return {
    title: "Diagnostico gerencial de estoque",
    metric: "estoque",
    grain: "product",
    entities: ["products"],
    filters: plan.filters,
    charts: [{ type: "bar", title: "Estoque disponivel por produto", xKey: "produto", yKey: "disponivel" }],
    recommendations: ["Priorize reposicao de produtos com baixo saldo disponivel e alto volume vendido."],
    sql: `
SELECT
  p.name AS produto,
  p.sku AS sku,
  p."availableStock"::int AS disponivel,
  p."reservedStock"::int AS reservado,
  ROUND(p."unitPriceCents" / 100.0, 2)::float AS preco
FROM "Product" p
WHERE p.status = 'active'
ORDER BY p."availableStock" ASC, p.name ASC
LIMIT 50`.trim()
  };
}

function buildClarificationReport(plan: IntelligentReportPlan, dataSource: "postgres" | "demo-memory") {
  return {
    title: "Relatorio gerencial - esclarecimento necessario",
    summary: plan.clarificationQuestion ?? "Preciso de mais contexto para gerar o relatorio.",
    executiveSummary: [plan.clarificationQuestion ?? "Informe o indicador desejado."],
    sql: "",
    columns: [],
    rows: [],
    insights: [],
    recommendations: ["Diga, por exemplo: faturamento por cliente este mes, produtos mais vendidos, notas emitidas ou risco de estoque."],
    plan,
    dataSource,
    generatedAt: new Date().toISOString()
  } satisfies IntelligentReport;
}

function inferMetric(normalized: string) {
  if (/\b(nota|notas|nf|nfs|fiscal|emitid)\b/.test(normalized)) return "invoices";
  if (/\b(estoque|ruptura|reposicao|saldo)\b/.test(normalized)) return "stock";
  if (/\b(faturamento|receita|valor|venda|vendas|produto|produtos|cliente|clientes|ranking|top|tendencia|evolucao|margem|lucro|rentabilidade)\b/.test(normalized)) return "sales";
  return "generic";
}

function inferGrain(normalized: string): IntelligentReportPlan["grain"] {
  if (/\b(nota|notas|nf|nfs|fiscal)\b/.test(normalized)) return "invoice";
  if (/\b(cliente|clientes)\b/.test(normalized)) return "customer";
  if (/\b(dia|diario|diaria|evolucao|tendencia|tempo)\b/.test(normalized)) return "day";
  if (/\b(pedido|pedidos)\b/.test(normalized)) return "order";
  return "product";
}

function inferDateRange(normalized: string): AnalyticsDateRange {
  if (/\b(hoje|dia atual)\b/.test(normalized)) return "today";
  if (/\b(30 dias|trinta dias|ultimos 30|ultimos trinta)\b/.test(normalized)) return "last_30_days";
  if (/\b(7 dias|sete dias|ultima semana|ultimos 7)\b/.test(normalized)) return "last_7_days";
  if (/\b(mes|m[eê]s|mensal|este mes|m[eê]s atual)\b/.test(normalized)) return "month_to_date";
  return "all_time";
}

function datePredicate(column: string, dateRange: AnalyticsDateRange) {
  if (dateRange === "today") {
    return `AND ${column} >= date_trunc('day', NOW())`;
  }
  if (dateRange === "last_7_days") {
    return `AND ${column} >= NOW() - INTERVAL '7 days'`;
  }
  if (dateRange === "last_30_days") {
    return `AND ${column} >= NOW() - INTERVAL '30 days'`;
  }
  if (dateRange === "month_to_date") {
    return `AND ${column} >= date_trunc('month', NOW())`;
  }
  return "";
}

function summarizeRows(metric: string, rows: Array<Record<string, ReportValue>>) {
  if (!rows.length) {
    return `Nao encontrei dados para ${metric} nos filtros informados.`;
  }
  const first = rows[0] ?? {};
  const firstLabel = String(first.produto ?? first.cliente ?? first.dia ?? first.nota ?? "primeiro item");
  return `Analise de ${metric} gerada com ${rows.length} linha(s). Destaque principal: ${firstLabel}.`;
}

function buildExecutiveSummary(metric: string, rows: Array<Record<string, ReportValue>>, total: number) {
  if (!rows.length) {
    return ["Nao ha dados suficientes para gerar conclusoes no periodo solicitado."];
  }
  return [
    `O relatorio analisou ${total} linha(s) de ${metric}.`,
    `O primeiro item da ordenacao concentra o principal ponto de atencao gerencial.`,
    "A consulta foi executada em modo somente leitura sobre o banco operacional."
  ];
}

function buildInsights(metric: string, rows: Array<Record<string, ReportValue>>) {
  if (!rows.length) {
    return ["Sem dados para o periodo selecionado."];
  }
  const first = rows[0] ?? {};
  const label = String(first.produto ?? first.cliente ?? first.dia ?? first.nota ?? "item lider");
  const amountKey = first.faturamento !== undefined ? "faturamento"
    : first.valor !== undefined ? "valor"
      : first.quantidade !== undefined ? "quantidade"
        : first.disponivel !== undefined ? "disponivel"
          : null;
  const amount = amountKey ? first[amountKey] ?? null : null;
  return [
    amount === null ? `${label} aparece como principal linha do relatorio.` : `${label} lidera o relatorio com ${formatInsightValue(amountKey, amount)}.`,
    rows.length > 1 ? "Ha dados suficientes para comparacao entre linhas." : "A analise possui apenas uma linha no periodo."
  ];
}

function formatInsightValue(key: string | null, value: ReportValue) {
  if (typeof value !== "number") {
    return String(value);
  }
  if (key === "faturamento" || key === "valor" || key === "preco") {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
  }
  return String(value);
}

function inferEmptyColumns(plan: IntelligentReportPlan) {
  if (plan.metric === "invoices") return ["nota", "emissao", "pedido", "cliente", "status", "valor"];
  if (plan.metric === "stock") return ["produto", "sku", "disponivel", "reservado", "preco"];
  if (plan.grain === "customer") return ["cliente", "pedidos", "faturamento", "ultimo_pedido"];
  if (plan.grain === "day") return ["dia", "pedidos", "quantidade", "faturamento"];
  return ["produto", "quantidade", "faturamento", "pedidos"];
}

function translateDateRange(dateRange: AnalyticsDateRange) {
  const labels: Record<AnalyticsDateRange, string> = {
    today: "hoje",
    last_7_days: "ultimos 7 dias",
    last_30_days: "ultimos 30 dias",
    month_to_date: "mes atual",
    all_time: "todo o periodo"
  };
  return labels[dateRange];
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
