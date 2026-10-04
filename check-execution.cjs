"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const examples = require("./example-records.json");
const { classifyRecords } = require("./classify.cjs");
const workflow = require("./workflow.json");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const owns = (value, key) => Object.hasOwn(value, key);

// Read one whole JSON container, never promoting its children to separate results.
// JSON.parse checks the grammar; this scanner additionally rejects duplicate keys,
// which JSON.parse would silently overwrite (including error/status/runData keys).
function readContainer(source, start) {
  const stack = [];
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      const begin = i;
      let closed = false;
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === '"') { closed = true; break; }
      }
      assert(closed, "Truncated JSON string in execution log");
      let next = i + 1;
      while (/\s/.test(source[next] || "") && next < source.length) next++;
      if (source[next] === ":" && stack.at(-1)?.keys) {
        const key = JSON.parse(source.slice(begin, i + 1));
        const keys = stack.at(-1).keys;
        assert(!keys.has(key), "Duplicate JSON key in execution log");
        keys.add(key);
      }
    } else if (char === "{" || char === "[") {
      stack.push({ closing: char === "{" ? "}" : "]", keys: char === "{" ? new Set() : null });
    } else if (char === "}" || char === "]") {
      assert.equal(stack.at(-1)?.closing, char, "Mismatched JSON delimiters in execution log");
      stack.pop();
      if (stack.length === 0) {
        let value;
        try { value = JSON.parse(source.slice(start, i + 1)); }
        catch { assert.fail("Malformed JSON in execution log"); }
        return { value, end: i + 1 };
      }
    }
  }
  assert.fail("Truncated JSON container in execution log");
}

function looksLikeContainer(source, index) {
  if (source[index] !== "{" && source[index] !== "[") return false;
  if (source[index - 1] === "\u001b" && /^\[[0-9;]*m/.test(source.slice(index))) return false;
  const rest = source.slice(index + 1).trimStart();
  // Ordinary diagnostics such as "[license SDK]" or "Stopped {okay}" are prose.
  // Once a JSON-looking container starts, malformed/incomplete input is fatal.
  if (source[index] === "{") return /^(?:"|}|$|[A-Za-z_$][\w$-]*\s*:)/.test(rest);
  // Bracketed ISO timestamps are diagnostic prefixes, not JSON arrays.
  if (/^\[\d{4}-\d{2}-\d{2}T[^\]\r\n]+\]/.test(source.slice(index))) return false;
  if (source[index] === "[") return /^(?:"|\{|\[|\]|-?\d|true\b|false\b|null\b|$)/.test(rest);
  return false;
}

function isExecutionLike(value) {
  return isObject(value) && (
    ["finished", "workflowId", "workflowData", "resultData", "runData"].some(key => owns(value, key)) ||
    (isObject(value.data) && owns(value.data, "resultData"))
  );
}

function checkDiagnostic(value) {
  if (value === null || typeof value !== "object") return;
  assert(!isExecutionLike(value), "Nested or additional execution-like JSON in execution log");
  if (isObject(value)) {
    assert(value.error == null, "Error-bearing JSON diagnostic in execution log");
    assert(value.errors == null || (Array.isArray(value.errors) && value.errors.length === 0),
      "Error-bearing JSON diagnostic in execution log");
    assert(!["error", "failed", "crashed", "canceled", "cancelled"].includes(String(value.status).toLowerCase()),
      "Failure-status JSON diagnostic in execution log");
    assert(!["error", "fatal"].includes(String(value.level).toLowerCase()),
      "Error-level JSON diagnostic in execution log");
  }
  for (const child of Object.values(value)) checkDiagnostic(child);
}

function parseExecutionLog(source) {
  assert.equal(typeof source, "string", "Execution log must be text");
  const executions = [];
  const prose = [];
  let proseStart = 0;
  for (let i = 0; i < source.length; i++) {
    if (!looksLikeContainer(source, i)) continue;
    prose.push(source.slice(proseStart, i));
    const { value, end } = readContainer(source, i);
    const executionLike = isExecutionLike(value);
    if (executionLike) executions.push(value);
    else checkDiagnostic(value);
    // A JSON record must end at a line boundary, EOF, or the next JSON record.
    // Do not salvage a valid prefix from a malformed record such as "{...},}".
    let next = end;
    while (source[next] === " " || source[next] === "\t") next++;
    assert(!executionLike || next === source.length || /[\r\n]/.test(source[next]) || looksLikeContainer(source, next),
      "Unexpected trailing content after JSON in execution log");
    i = end - 1;
    proseStart = end;
  }
  prose.push(source.slice(proseStart));
  const diagnostics = prose.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert(!/^\s*[,}\]](?:\s*[,}\]])*\s*$/m.test(diagnostics),
    "Unmatched JSON punctuation in execution log");
  // Do not grep for "failed": n8n's known non-fatal Python-runner warning uses it.
  // Explicit error/fatal severity and CLI execution-failure diagnostics are fatal.
  const lines = diagnostics.split(/\r?\n/).map(line => line.replace(
    /^\s*(?:\[\d{4}-\d{2}-\d{2}T[^\]]+\]|\d{4}-\d{2}-\d{2}T\S+)\s*/, ""));
  assert(!lines.some(line => /^(?:\s*(?:error|fatal)(?:\b|:)|\s*\[(?:error|fatal)\]|\s*(?:there was a )?problem executing (?:the )?workflow\b|\s*workflow execution (?:failed|error)\b)/i.test(line)),
    "Error diagnostic in execution log");
  assert.equal(executions.length, 1, "Execution log must contain exactly one complete execution result");
  return executions[0];
}

function assertSuccess(value, label, required) {
  assert(value.error == null, label + " reported an error");
  if (owns(value, "finished")) assert.equal(value.finished, true, label + " was not finished");
  if (owns(value, "status")) assert.equal(value.status, "success", label + " status was not success");
  if (owns(value, "executionStatus")) assert.equal(value.executionStatus, "success", label + " task status was not success");
  if (required) assert(value.finished === true || value.status === "success", label + " has no success/completion marker");
}

function verifyExecution(execution) {
  assert(isObject(execution), "Execution result must be an object");
  assertSuccess(execution, "Execution", true);
  assert(isObject(execution.data), "Execution has no data");
  assert(execution.data.error == null, "Execution data reported an error");
  const result = execution.data.resultData;
  assert(isObject(result), "Execution has no resultData");
  assertSuccess(result, "Execution result", false);
  const runData = result.runData;
  assert(isObject(runData), "Execution has no runData object");
  const nodeNames = [
    "Run example", "Fictional intake records", "Validate and classify",
    "Ready queue", "Review queue", "Duplicate log", "Count and reconcile",
  ];
  assert.deepEqual(Object.keys(runData).sort(), [...nodeNames].sort(), "Execution must contain exactly the seven workflow nodes");
  if (owns(execution, "workflowId")) assert.equal(execution.workflowId, workflow.id, "Unexpected workflow ID");
  if (owns(execution, "workflowData")) {
    assert(isObject(execution.workflowData), "Invalid workflowData");
    if (owns(execution.workflowData, "id")) assert.equal(execution.workflowData.id, workflow.id, "Unexpected workflow ID");
    if (owns(execution.workflowData, "nodes")) {
      assert(Array.isArray(execution.workflowData.nodes), "Invalid workflow node list");
      assert.deepEqual(execution.workflowData.nodes.map(node => node?.name).sort(), [...nodeNames].sort(), "Unexpected workflow node list");
    }
  }
  function output(name) {
    assert(Array.isArray(runData[name]), name + " has no task list");
    assert.equal(runData[name].length, 1, name + " must execute exactly once");
    const task = runData[name][0];
    assert(isObject(task), name + " has an invalid task");
    assertSuccess(task, name, false);
    assert(isObject(task.data), name + " has no output data");
    assert.deepEqual(Object.keys(task.data), ["main"], name + " has unexpected output types");
    assert(Array.isArray(task.data.main), name + " has no main output");
    assert.equal(task.data.main.length, 1, name + " must have exactly one output branch");
    assert(Array.isArray(task.data.main[0]), name + " has no output items");
    return task.data.main[0].map(item => {
      assert(isObject(item) && isObject(item.json), name + " has an invalid JSON item");
      assert(item.error == null, name + " has an error-bearing output item");
      return item.json;
    });
  }
  assert.deepEqual(output("Run example"), [{}], "Unexpected manual-trigger output");
  assert.deepEqual(output("Fictional intake records"), examples);
  const classified = output("Validate and classify");
  assert.deepEqual(classified, classifyRecords(examples), "Classification differs from the full expected records");
  const ready = output("Ready queue");
  const review = output("Review queue");
  const duplicate = output("Duplicate log");
  assert.deepEqual(ready, classified.filter(row => row.status === "ready"), "Ready queue differs from classification");
  assert.deepEqual(review, classified.filter(row => row.status === "review"), "Review queue differs from classification");
  assert.deepEqual(duplicate, classified.filter(row => row.status === "duplicate"), "Duplicate log differs from classification");
  const all = [...ready, ...review, ...duplicate].sort((a, b) => a.source_row - b.source_row);
  assert.deepEqual(all, classified, "Queues must account for every classified record exactly once");
  const audit = {
    input_count: examples.length, output_count: all.length,
    ready_count: ready.length, review_count: review.length, duplicate_count: duplicate.length,
    ready_ids: ready.map(row => row.normalized.external_id), review_rows: review.map(row => row.source_row),
    duplicate_pairs: duplicate.map(row => ({ source_row: row.source_row, duplicate_of_row: row.duplicate_of_row })),
    all_inputs_accounted_for: true,
  };
  // Retain an independent fixed baseline, in addition to reconciling actual rows.
  assert.deepEqual(audit, {
    input_count: 8, output_count: 8, ready_count: 3, review_count: 4, duplicate_count: 1,
    ready_ids: ["001", "005", "007"], review_rows: [2, 4, 5, 7],
    duplicate_pairs: [{ source_row: 3, duplicate_of_row: 1 }], all_inputs_accounted_for: true,
  }, "Unexpected fictional-example baseline");
  assert.deepEqual(output("Count and reconcile"), [audit], "Reconciliation differs from validated queues");
  return { verified: true, nodes_executed: nodeNames.length, ...audit };
}

if (require.main === module) {
  try {
    const source = fs.readFileSync(process.argv[2] || "execution.log", "utf8");
    console.log(JSON.stringify(verifyExecution(parseExecutionLog(source)), null, 2));
  } catch (error) {
    console.error("Execution verification failed: " + error.message);
    process.exitCode = 1;
  }
}
module.exports = { parseExecutionLog, verifyExecution };
