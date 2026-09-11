"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const examples = require("./example-records.json");

const source = fs.readFileSync(process.argv[2] || "execution.log", "utf8");
let execution;
// n8n prints a pretty JSON object; startup/shutdown messages may surround it.
for (const match of source.matchAll(/^\{/gm)) {
  let depth = 0, inString = false, escaped = false;
  for (let i = match.index; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          const candidate = JSON.parse(source.slice(match.index, i + 1));
          if (candidate.data?.resultData?.runData) execution = candidate;
        } catch {}
        break;
      }
    }
  }
}
assert(execution, "No complete n8n execution result was found");
assert(!execution.data.resultData.error, "n8n reported an execution error");
assert(execution.finished === true || execution.status === "success", "Execution was not complete");
const runData = execution.data.resultData.runData;
function output(name) {
  assert.equal(runData[name]?.length, 1, name + " must execute exactly once");
  const task = runData[name][0];
  assert(!task.error, name + " returned an error");
  assert(Array.isArray(task.data?.main?.[0]), name + " has no output");
  return task.data.main[0].map(item => item.json);
}
output("Run example");
assert.deepEqual(output("Fictional intake records"), examples);
const classified = output("Validate and classify");
assert.equal(classified.length, 8);
assert.deepEqual(classified.map(row => row.original), examples);

const ready = output("Ready queue");
const review = output("Review queue");
const duplicate = output("Duplicate log");
assert.deepEqual(ready.map(row => row.source_row), [1, 6, 8]);
assert.deepEqual(ready.map(row => row.normalized.external_id), ["001", "005", "007"]);
assert.equal(ready[1].normalized.email, "sara@example.test");
assert.equal(ready[2].normalized.email, "Jo@example.test");
assert.deepEqual(review.map(row => row.source_row), [2, 4, 5, 7]);
assert(review.filter(row => [2, 7].includes(row.source_row)).every(row => row.reasons.includes("conflicting_id")));
assert(review.find(row => row.source_row === 4).reasons.includes("missing_email"));
assert(review.find(row => row.source_row === 5).reasons.includes("email_format_needs_review"));
assert.deepEqual(duplicate.map(row => [row.source_row, row.duplicate_of_row]), [[3, 1]]);
const all = [...ready, ...review, ...duplicate].sort((a, b) => a.source_row - b.source_row);
assert.deepEqual(all.map(row => row.source_row), [1, 2, 3, 4, 5, 6, 7, 8]);
assert.deepEqual(all.map(row => row.original), examples);

const expectedAudit = {
  input_count: 8, output_count: 8,
  ready_count: 3, review_count: 4, duplicate_count: 1,
  ready_ids: ["001", "005", "007"], review_rows: [2, 4, 5, 7],
  duplicate_pairs: [{ source_row: 3, duplicate_of_row: 1 }],
  all_inputs_accounted_for: true,
};
assert.deepEqual(output("Count and reconcile"), [expectedAudit]);
console.log(JSON.stringify({ verified: true, nodes_executed: Object.keys(runData).length, ...expectedAudit }, null, 2));
