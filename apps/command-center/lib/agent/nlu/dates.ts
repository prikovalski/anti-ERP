import type { AnalyticsDateRange } from "@anti-erp/shared";
import { normalizeText } from "./text";

/** One interpretation of relative periods for every route (reports, lists, inventory history). */
export function inferDateRange(message: string): AnalyticsDateRange {
  const normalized = normalizeText(message);
  if (/\b(ultimos?\s+30|ultimos?\s+trinta|trinta\s+dias|30\s+dias)\b/.test(normalized)) {
    return "last_30_days";
  }
  if (/\b(ultimos?\s+7|ultimos?\s+sete|sete\s+dias|7\s+dias|semana)\b/.test(normalized)) {
    return "last_7_days";
  }
  if (/\b(mes|mensal|mtd)\b/.test(normalized)) {
    return "month_to_date";
  }
  if (/\b(hoje|diario)\b|\bdo\s+dia\b(?!\s+\d)/.test(normalized)) {
    return "today";
  }
  return "all_time";
}

export type ExplicitDatePeriod = { dateFrom: string; dateTo: string; label: string };

/** Calendar periods that need exact bounds, e.g. "semana passada" or "dia 01/01/2020". */
export function inferExplicitDatePeriod(message: string, now = new Date()): ExplicitDatePeriod | null {
  const normalized = normalizeText(message);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/\bsemana passada\b/.test(normalized)) {
    const start = startOfWeek(today);
    start.setDate(start.getDate() - 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { dateFrom: formatDateInput(start), dateTo: formatDateInput(end), label: "semana passada" };
  }

  if (/\b(ultima semana|ultimos 7 dias|ultimos sete dias)\b/.test(normalized)) {
    const start = new Date(today);
    start.setDate(today.getDate() - 6);
    return { dateFrom: formatDateInput(start), dateTo: formatDateInput(today), label: "ultimos 7 dias" };
  }

  if (/\bmes passado\b/.test(normalized)) {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { dateFrom: formatDateInput(start), dateTo: formatDateInput(end), label: "mes passado" };
  }

  if (/\b(ultimo mes|ultimos 30 dias|ultimos trinta dias)\b/.test(normalized)) {
    const start = new Date(today);
    start.setDate(today.getDate() - 29);
    return { dateFrom: formatDateInput(start), dateTo: formatDateInput(today), label: "ultimos 30 dias" };
  }

  const dayMatch = normalized.match(/\bdia\s+(\d{1,2})(?:[/-](\d{1,2})(?:[/-](\d{2,4}))?)?\b/);
  if (dayMatch?.[1]) {
    const day = Number(dayMatch[1]);
    const month = dayMatch[2] ? Number(dayMatch[2]) - 1 : today.getMonth();
    const rawYear = dayMatch[3] ? Number(dayMatch[3]) : today.getFullYear();
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const date = new Date(year, month, day);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
      return { dateFrom: formatDateInput(date), dateTo: formatDateInput(date), label: `dia ${day}` };
    }
  }

  return null;
}

function startOfWeek(date: Date) {
  const start = new Date(date);
  const day = start.getDay();
  start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day));
  return start;
}

function formatDateInput(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
