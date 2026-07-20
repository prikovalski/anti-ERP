import type { IntelligentReport } from "@anti-erp/shared";
import PDFDocument from "pdfkit";

type PdfBuffer = Buffer;
type ReportValue = IntelligentReport["rows"][number][string];

const page = {
  margin: 44,
  width: 595.28,
  height: 841.89
};

const colors = {
  ink: "#17201e",
  muted: "#667085",
  line: "#d9dee7",
  soft: "#f4f7f8",
  brand: "#0d7f6f",
  dark: "#071412",
  accent: "#8dd8c8"
};

export async function renderIntelligentReportPdf(report: IntelligentReport) {
  return new Promise<PdfBuffer>((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margin: page.margin,
      info: {
        Title: report.title,
        Author: "Anti-ERP",
        Subject: "Relatorio gerencial inteligente"
      }
    });
    const chunks: Buffer[] = [];

    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    drawHeader(document, report);
    drawExecutiveSummary(document, report);
    drawChart(document, report);
    drawTable(document, report);
    drawSqlAppendix(document, report);

    document.end();
  });
}

export function buildIntelligentReportPdfFilename(report: IntelligentReport) {
  const slug = report.title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);

  return `${slug || "relatorio-gerencial"}-${report.generatedAt.slice(0, 10)}.pdf`;
}

function drawHeader(document: PDFKit.PDFDocument, report: IntelligentReport) {
  document
    .rect(0, 0, page.width, 128)
    .fill(colors.dark);

  document
    .fillColor(colors.accent)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("ANTI-ERP", page.margin, 34);

  document
    .fillColor("#ffffff")
    .fontSize(24)
    .text(report.title, page.margin, 54, { width: page.width - page.margin * 2 - 120 });

  document
    .fillColor("#b8c4c1")
    .font("Helvetica")
    .fontSize(9)
    .text(`Gerado em ${formatDateTime(report.generatedAt)} | Fonte: ${report.dataSource}`, page.margin, 93);

  document
    .roundedRect(page.width - page.margin - 112, 36, 112, 34, 17)
    .fill("#123530")
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text("PDF GERENCIAL", page.width - page.margin - 96, 48);

  document.y = 158;
}

function drawExecutiveSummary(document: PDFKit.PDFDocument, report: IntelligentReport) {
  ensureSpace(document, 185);
  sectionTitle(document, "Resumo executivo");

  const boxTop = document.y;
  document
    .roundedRect(page.margin, boxTop, page.width - page.margin * 2, 78, 10)
    .fill(colors.soft);

  document
    .fillColor(colors.ink)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(report.summary, page.margin + 16, boxTop + 14, { width: page.width - page.margin * 2 - 32 });

  document
    .fillColor(colors.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(`Indicador: ${report.plan.metric} | Periodo: ${translateDateRange(report.plan.dateRange)} | Linhas: ${report.rows.length}`, page.margin + 16, boxTop + 50);

  document.y = boxTop + 100;

  const bullets = [...report.executiveSummary, ...report.insights, ...report.recommendations].slice(0, 8);
  for (const item of bullets) {
    ensureSpace(document, 24);
    document
      .circle(page.margin + 4, document.y + 6, 2.3)
      .fill(colors.brand)
      .fillColor(colors.ink)
      .font("Helvetica")
      .fontSize(10)
      .text(item, page.margin + 16, document.y, { width: page.width - page.margin * 2 - 16 });
    document.moveDown(0.45);
  }

  document.moveDown(0.5);
}

function drawChart(document: PDFKit.PDFDocument, report: IntelligentReport) {
  const chart = report.plan.charts.find((item) => item.type === "bar" && item.xKey && item.yKey);
  if (!chart?.xKey || !chart.yKey) return;

  const rows = report.rows
    .map((row) => ({
      label: String(row[chart.xKey ?? ""] ?? "-"),
      value: Number(row[chart.yKey ?? ""] ?? 0)
    }))
    .filter((row) => Number.isFinite(row.value))
    .slice(0, 8);

  if (!rows.length) return;

  ensureSpace(document, 235);
  sectionTitle(document, chart.title);

  const top = document.y + 6;
  const chartWidth = page.width - page.margin * 2;
  const chartHeight = 178;
  const labelWidth = 136;
  const barWidth = chartWidth - labelWidth - 82;
  const max = Math.max(...rows.map((row) => row.value), 1);
  const rowHeight = chartHeight / rows.length;

  document.roundedRect(page.margin, top, chartWidth, chartHeight + 22, 10).fill("#fbfcfd");

  rows.forEach((row, index) => {
    const y = top + 15 + index * rowHeight;
    const width = Math.max(4, (row.value / max) * barWidth);

    document
      .fillColor(colors.ink)
      .font("Helvetica")
      .fontSize(8.5)
      .text(truncate(row.label, 28), page.margin + 14, y + 3, { width: labelWidth - 18 });

    document
      .roundedRect(page.margin + labelWidth, y + 2, barWidth, 12, 6)
      .fill("#e8f3f0")
      .roundedRect(page.margin + labelWidth, y + 2, width, 12, 6)
      .fill(colors.brand);

    document
      .fillColor(colors.muted)
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .text(formatChartValue(chart.yKey ?? null, row.value), page.margin + labelWidth + barWidth + 10, y + 2, { width: 70 });
  });

  document.y = top + chartHeight + 38;
}

function drawTable(document: PDFKit.PDFDocument, report: IntelligentReport) {
  ensureSpace(document, 125);
  sectionTitle(document, "Dados detalhados");

  if (!report.rows.length) {
    document
      .fillColor(colors.muted)
      .font("Helvetica")
      .fontSize(10)
      .text("Nao foram encontrados dados para os filtros informados.");
    document.moveDown();
    return;
  }

  const columns = report.columns.slice(0, 6);
  const tableWidth = page.width - page.margin * 2;
  const widths = buildColumnWidths(columns, tableWidth);

  drawTableHeader(document, columns, widths);

  report.rows.slice(0, 40).forEach((row, rowIndex) => {
    drawTableRow(document, columns, widths, row, rowIndex);
  });

  if (report.rows.length > 40) {
    ensureSpace(document, 26);
    document
      .fillColor(colors.muted)
      .font("Helvetica-Oblique")
      .fontSize(9)
      .text(`Exibindo as primeiras 40 linhas de ${report.rows.length}.`, page.margin, document.y + 6);
    document.moveDown();
  }
}

function drawSqlAppendix(document: PDFKit.PDFDocument, report: IntelligentReport) {
  if (!report.sql) return;

  ensureSpace(document, 140);
  sectionTitle(document, "Consulta auditavel");
  document
    .fillColor(colors.muted)
    .font("Helvetica")
    .fontSize(9)
    .text("Consulta executada em modo somente leitura.", page.margin, document.y, { width: page.width - page.margin * 2 });
  document.moveDown(0.5);

  const sqlTop = document.y;
  document.roundedRect(page.margin, sqlTop, page.width - page.margin * 2, 110, 8).fill("#101828");
  document
    .fillColor("#d7e5ff")
    .font("Courier")
    .fontSize(7.5)
    .text(report.sql, page.margin + 12, sqlTop + 12, {
      width: page.width - page.margin * 2 - 24,
      height: 86,
      ellipsis: true
    });
  document.y = sqlTop + 128;
}

function drawTableHeader(document: PDFKit.PDFDocument, columns: string[], widths: number[]) {
  ensureSpace(document, 32);
  const y = document.y;
  let x = page.margin;

  document.rect(page.margin, y, widths.reduce((sum, width) => sum + width, 0), 28).fill(colors.dark);

  columns.forEach((column, index) => {
    const width = widths[index] ?? 80;
    document
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(8)
      .text(formatColumnLabel(column), x + 7, y + 9, { width: width - 14, height: 12 });
    x += width;
  });

  document.y = y + 28;
}

function drawTableRow(
  document: PDFKit.PDFDocument,
  columns: string[],
  widths: number[],
  row: Record<string, ReportValue>,
  rowIndex: number
) {
  ensureSpace(document, 34);

  const y = document.y;
  let x = page.margin;
  const rowHeight = 30;

  document
    .rect(page.margin, y, widths.reduce((sum, width) => sum + width, 0), rowHeight)
    .fill(rowIndex % 2 === 0 ? "#ffffff" : "#f8fafb");

  columns.forEach((column, index) => {
    const width = widths[index] ?? 80;
    const value = formatCell(row[column], column);
    const isNumeric = typeof row[column] === "number";

    document
      .strokeColor(colors.line)
      .lineWidth(0.5)
      .rect(x, y, width, rowHeight)
      .stroke()
      .fillColor(colors.ink)
      .font("Helvetica")
      .fontSize(8.5)
      .text(value, x + 7, y + 10, {
        width: width - 14,
        height: 12,
        align: isNumeric ? "right" : "left",
        ellipsis: true
      });
    x += width;
  });

  document.y = y + rowHeight;
}

function sectionTitle(document: PDFKit.PDFDocument, title: string) {
  document
    .fillColor(colors.ink)
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(title, page.margin, document.y);
  document
    .moveTo(page.margin, document.y + 4)
    .lineTo(page.width - page.margin, document.y + 4)
    .strokeColor(colors.line)
    .lineWidth(1)
    .stroke();
  document.moveDown(0.9);
}

function ensureSpace(document: PDFKit.PDFDocument, height: number) {
  if (document.y + height > page.height - 62) {
    document.addPage();
  }
}

function buildColumnWidths(columns: string[], tableWidth: number) {
  if (columns.length === 0) return [];
  const base = tableWidth / columns.length;
  return columns.map((column) => {
    if (/cliente|produto/i.test(column)) return Math.min(172, base + 35);
    if (/data|emissao|ultimo|dia/i.test(column)) return Math.max(78, base - 18);
    return Math.max(72, base - 4);
  }).map((width, _index, widths) => {
    const total = widths.reduce((sum, item) => sum + item, 0);
    return width * (tableWidth / total);
  });
}

function formatCell(value: ReportValue | undefined, column: string) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Sim" : "Nao";
  if (typeof value === "number") {
    if (/faturamento|valor|preco|margem|receita/i.test(column)) return money(value);
    return Number.isInteger(value) ? String(value) : money(value);
  }
  return String(value);
}

function formatChartValue(key: string | null, value: number) {
  if (/faturamento|valor|preco|margem|receita/i.test(key ?? "")) return compactMoney(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatColumnLabel(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function translateDateRange(value: IntelligentReport["plan"]["dateRange"]) {
  const labels: Record<IntelligentReport["plan"]["dateRange"], string> = {
    today: "hoje",
    last_7_days: "ultimos 7 dias",
    last_30_days: "ultimos 30 dias",
    month_to_date: "mes atual",
    all_time: "todo o historico"
  };
  return labels[value];
}

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}

function compactMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}
