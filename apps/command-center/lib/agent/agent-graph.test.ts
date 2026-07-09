import assert from "node:assert/strict";
import test from "node:test";
import { parseIntentLocally } from "./intent-parser";

test("local intent parser handles empty Studio input without crashing", () => {
  const result = parseIntentLocally(undefined);

  assert.equal(result.intent, "unknown");
  assert.equal(result.confidence, 0.4);
});
