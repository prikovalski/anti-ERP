import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanName,
  isInsideDateRange,
  normalizeText,
  roundMoney,
  slugify,
  translateDateRange
} from "./utils";

test("normalizeText removes accents, trims and compacts whitespace", () => {
  assert.equal(normalizeText("  João   da Silva  "), "joao da silva");
});

test("cleanName keeps original casing while trimming duplicated whitespace", () => {
  assert.equal(cleanName("  Maria   de Jesus  "), "Maria de Jesus");
});

test("slugify creates stable ascii identifiers", () => {
  assert.equal(slugify("Mouse QA 1200 Óptico"), "mouse_qa_1200_optico");
});

test("roundMoney rounds values to cents", () => {
  assert.equal(roundMoney(10.235), 10.24);
});

test("isInsideDateRange supports common analytics ranges", () => {
  const reference = new Date("2026-07-20T12:00:00.000Z");

  assert.equal(isInsideDateRange("2026-07-20T08:00:00.000Z", "today", reference), true);
  assert.equal(isInsideDateRange("2026-07-12T08:00:00.000Z", "last_7_days", reference), false);
  assert.equal(isInsideDateRange("2026-07-01T08:00:00.000Z", "month_to_date", reference), true);
  assert.equal(isInsideDateRange("2026-06-01T08:00:00.000Z", "all_time", reference), true);
});

test("translateDateRange returns user-facing Portuguese labels", () => {
  assert.equal(translateDateRange("last_30_days"), "ultimos 30 dias");
});
