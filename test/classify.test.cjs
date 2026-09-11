"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const examples = require("../example-records.json");
const { classifyRecords } = require("../classify.cjs");

test("the sample retains all eight inputs across the three queues", () => {
  const rows = classifyRecords(examples);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.filter(row => row.status === "ready").map(row => row.source_row), [1, 6, 8]);
  assert.deepEqual(rows.filter(row => row.status === "review").map(row => row.source_row), [2, 4, 5, 7]);
  assert.deepEqual(rows.filter(row => row.status === "duplicate").map(row => row.source_row), [3]);
  assert.equal(rows[2].duplicate_of_row, 1);
  assert.deepEqual(rows.map(row => row.original), examples);
});

test("normalization keeps IDs and email local parts intact", () => {
  const rows = classifyRecords(examples);
  assert.equal(rows[0].normalized.external_id, "001");
  assert.equal(rows[0].normalized.full_name, "Maya Chen");
  assert.equal(rows[5].normalized.email, "sara@example.test");
  assert.equal(rows[7].normalized.email, "Jo@example.test");
  assert.deepEqual(rows[5].changes, [{ field: "email", before: "sara@EXAMPLE.TEST", after: "sara@example.test" }]);
});

test("conflicting versions quarantine the earlier record as well", () => {
  const rows = classifyRecords([examples[1], examples[6]]);
  assert.deepEqual(rows.map(row => row.status), ["review", "review"]);
  assert(rows.every(row => row.reasons.includes("conflicting_id")));
});

test("numbers and unknown fields require review without losing the source", () => {
  const input = { external_id: 1, full_name: "Jo", email: "Jo@example.test", custom_note: "keep this" };
  const [row] = classifyRecords([input]);
  assert.equal(row.status, "review");
  assert(row.reasons.includes("non_text_external_id"));
  assert(row.reasons.includes("unmapped_fields"));
  assert.deepEqual(row.original, input);
  assert.equal(row.original.custom_note, "keep this");
});

test("an invalid record sharing an ID cannot leave an apparently safe copy", () => {
  const good = { external_id: "009", full_name: "Jo", email: "Jo@example.test" };
  const bad = { ...good, note: "additional information" };
  const rows = classifyRecords([good, bad]);
  assert(rows.every(row => row.status === "review"));
  assert(rows.every(row => row.reasons.includes("conflicting_id")));
});

test("empty input and malformed records are handled without mutation", () => {
  assert.deepEqual(classifyRecords([]), []);
  const copy = structuredClone(examples);
  copy.forEach(Object.freeze);
  Object.freeze(copy);
  classifyRecords(copy);
  assert.deepEqual(copy, examples);
  const malformed = classifyRecords([null, "text", []]);
  assert(malformed.every(row => row.status === "review"));
  assert(malformed.every(row => row.reasons.includes("record_is_not_an_object")));
});
