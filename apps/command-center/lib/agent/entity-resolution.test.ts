import assert from "node:assert/strict";
import test from "node:test";
import type { Customer } from "@anti-erp/shared";
import { createCustomerDisambiguation } from "./disambiguation";
import { resolveCandidates } from "./entity-resolution";

function customer(id: string, name: string): Customer {
  return { id, name, taxId: `${id}-tax`, city: "Sao Paulo", status: "active" };
}

const northstar = customer("cus_northstar", "Northstar Labs");
const globo = customer("cus_globo", "Globo Retail Labs");

test("several partial matches become a question", () => {
  const resolution = resolveCandidates("la", [northstar, globo], createCustomerDisambiguation);

  assert.equal(resolution.status, "ambiguous");
  assert.deepEqual(
    resolution.status === "ambiguous" ? resolution.clarification.options.map((option) => option.label) : [],
    ["Northstar Labs", "Globo Retail Labs"]
  );
});

test("an exact name wins over other partial matches", () => {
  const labs = customer("cus_labs", "Labs");
  const resolution = resolveCandidates("labs", [northstar, labs, globo], createCustomerDisambiguation);

  assert.deepEqual(resolution, { status: "resolved", entity: labs });
});

test("a single candidate resolves and no candidate is not found", () => {
  assert.deepEqual(resolveCandidates("north", [northstar], createCustomerDisambiguation), { status: "resolved", entity: northstar });
  assert.deepEqual(resolveCandidates("acme", [], createCustomerDisambiguation), { status: "not_found" });
});
