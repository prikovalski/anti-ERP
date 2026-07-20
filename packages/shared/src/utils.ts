export type DateRange = "today" | "last_7_days" | "last_30_days" | "month_to_date" | "all_time";

export function nowIso() {
  return new Date().toISOString();
}

export function compactWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeText(value: string) {
  return compactWhitespace(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function cleanName(value: string) {
  return compactWhitespace(value);
}

export function slugify(value: string, maxLength = 28) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
}

export function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export function isInsideDateRange(createdAt: string, dateRange: DateRange, referenceDate = new Date()) {
  if (dateRange === "all_time") {
    return true;
  }

  const date = new Date(createdAt);
  const start = new Date(referenceDate);
  if (dateRange === "today") {
    start.setHours(0, 0, 0, 0);
  }
  if (dateRange === "last_7_days") {
    start.setDate(start.getDate() - 7);
  }
  if (dateRange === "last_30_days") {
    start.setDate(start.getDate() - 30);
  }
  if (dateRange === "month_to_date") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }
  return date >= start && date < referenceDate;
}

export function translateDateRange(dateRange: DateRange) {
  if (dateRange === "today") return "hoje";
  if (dateRange === "last_7_days") return "ultimos 7 dias";
  if (dateRange === "last_30_days") return "ultimos 30 dias";
  if (dateRange === "month_to_date") return "mes atual";
  return "todo o periodo";
}
