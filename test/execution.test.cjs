"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseExecutionLog, verifyExecution } = require("../check-execution.cjs");

// Recorded CLI output, not produced by the classifier/parser under test.
const fixturePath = path.join(__dirname, "fixtures/n8n-2.38.7-success.log");
const realLog = fs.readFileSync(fixturePath, "utf8");
const baseline = JSON.parse(realLog.slice(realLog.indexOf("\n{") + 1));
const clone = () => structuredClone(baseline);
const json = value => JSON.stringify(value, null, 2);
const runData = value => value.data.resultData.runData;
const task = (value, name = "Ready queue") => runData(value)[name][0];
const output = (value, name = "Ready queue") => task(value, name).data.main[0];
const mutated = change => { const value = clone(); change(value); return json(value); };
const success = json(baseline);
const failed = clone();
failed.finished = false;
failed.status = "error";
failed.data.resultData.error = { message: "SYNTHETIC failure" };
const failure = json(failed);
const verify = source => verifyExecution(parseExecutionLog(source));
const expected = {
  verified: true, nodes_executed: 7, input_count: 8, output_count: 8,
  ready_count: 3, review_count: 4, duplicate_count: 1,
  ready_ids: ["001", "005", "007"], review_rows: [2, 4, 5, 7],
  duplicate_pairs: [{ source_row: 3, duplicate_of_row: 1 }], all_inputs_accounted_for: true,
};

const positive = [
  ["recorded n8n 2.38.7 output including non-fatal Python-runner warning", realLog],
  ["plain successful JSON", success],
  ["minified JSON", JSON.stringify(baseline)],
  ["startup and shutdown prose", "Starting n8n\n" + success + "\nShutting down n8n\n"],
  ["brace-like diagnostic prose", "{not JSON}\n{\nlog mentions } and {\n" + success + "\nStopped {okay}\n"],
  ["unrelated complete JSON diagnostics", '{"log":"start { }"}\n' + success + '\n{"log":"done"}\n'],
  ["unrelated JSON arrays", '[{"log":"start"}, 42, null]\n' + success + '\n[]\n'],
  ["informational JSON status", '{"level":"info","status":"ready","message":"Startup complete"}\n' + success],
  ["bracketed ISO timestamp", "[2026-10-04T12:30:00Z] Starting n8n\n" + success],
  ["ANSI-colored informational diagnostic", "\u001b[32mStarting n8n\u001b[0m\n" + success],
  ["inline diagnostic JSON", 'Startup configuration {"mode":"cli"} loaded\n' + success],
  ["CRLF output", realLog.replace(/\n/g, "\r\n")],
  ["indented output", success.split("\n").map(line => "  " + line).join("\n")],
  ["status-only legacy completion marker", mutated(value => { delete value.finished; })],
  ["finished-only legacy completion marker", mutated(value => { delete value.status; })],
  ["absent optional task statuses", mutated(value => { for (const tasks of Object.values(runData(value))) delete tasks[0].executionStatus; })],
  ["null error fields", mutated(value => { value.error = null; value.data.resultData.error = null; task(value).error = null; })],
  ["matching optional workflow identity", mutated(value => { value.workflowId = "IntakeDemo260911"; value.workflowData = { id: "IntakeDemo260911" }; })],
  ["escaped quotes, braces, backslashes and structural-looking text in a string", mutated(value => {
    value.note = 'literal } { ] [ \\" escaped quote " and \\\\ slash; {"status":"error","data":{"resultData":{}}}';
  })],
];
for (const [name, source] of positive) test("accepts " + name, () => assert.deepEqual(verify(source), expected));

const negative = [
  ["empty input", ""],
  ["only diagnostics", "Starting n8n\n"],
  ["single failed execution", failure],
  ["success then failed execution", success + "\n" + failure],
  ["failed execution then success", failure + "\n" + success],
  ["two complete successes", success + "\n" + success],
  ["success then truncated error", success + "\n" + failure.slice(0, -1)],
  ["truncated error before success", failure.slice(0, -1) + "\n" + success],
  ["success then malformed error", success + "\n" + failure.slice(0, -1) + ",}"],
  ["success then indented error", success + "\n" + failure.split("\n").map(line => "  " + line).join("\n")],
  ["same-line success then error", JSON.stringify(baseline) + " " + JSON.stringify(failed)],
  ["same-line error then success", JSON.stringify(failed) + JSON.stringify(baseline)],
  ["error without runData", success + '\n{"data":{"resultData":{"error":{"message":"SYNTHETIC failure"}}}}'],
  ["error with null runData", success + '\n{"data":{"resultData":{"runData":null,"error":"SYNTHETIC failure"}}}'],
  ["unquoted malformed wrapper containing success", '{outer:\n' + success + "}"],
  ["truncated wrapper containing success", '{"outer":\n' + success],
  ["complete wrapper containing success", '{"outer":\n' + success + "}"],
  ["array wrapper containing success", "[" + success + "]"],
  ["only truncated execution", success.slice(0, -1)],
  ["only malformed execution", success.slice(0, -1) + ",}"],
  ["truncated JSON diagnostic after success", success + '\n{"log":"unfinished'],
  ["trailing bare container", success + "\n{"],
  ["newline unmatched object delimiter", success + "\n}"],
  ["newline unmatched array delimiter", success + "\n]"],
  ["newline malformed punctuation", success + "\n,}"],
  ["malformed suffix", success + ",}"],
  ["error-bearing JSON diagnostic", success + '\n{"error":"SYNTHETIC failure"}'],
  ["nested error-bearing JSON diagnostic", '{"log":{"error":"SYNTHETIC failure"}}\n' + success],
  ["JSON error severity", success + '\n{"level":"error","message":"SYNTHETIC failure"}'],
  ["explicit CLI error diagnostic", success + "\nError: SYNTHETIC failure\n"],
  ["timestamped CLI error diagnostic", success + "\n[2026-10-04T12:30:00Z] Error: SYNTHETIC failure\n"],
  ["ANSI-colored CLI error diagnostic", success + "\n\u001b[31mError: SYNTHETIC failure\u001b[0m\n"],
  ["workflow failure diagnostic", success + "\nWorkflow execution failed: SYNTHETIC failure\n"],
  ["failure-status JSON diagnostic", success + '\n{"status":"error","message":"SYNTHETIC failure"}'],
  ["CLI execution-failure diagnostic", "There was a problem executing the workflow\n" + success],
  ["duplicate top-level status keys", success.replace('"status": "success",\n  "finished"', '"status": "error",\n  "status": "success",\n  "finished"')],
  ["duplicate escaped status key", success.replace('"status": "success",\n  "finished"', '"sta\\u0074us": "error",\n  "status": "success",\n  "finished"')],
  ["duplicate error field hidden by null", success.replace('"resultData": {', '"resultData": {"error":{"message":"SYNTHETIC failure"},"error":null,')],
  ["duplicate runData key", success.replace('"runData": {', '"runData": {}, "runData": {')],
  ["finished true with error status", mutated(value => { value.status = "error"; })],
  ["finished true with running status", mutated(value => { value.status = "running"; })],
  ["finished false with success status", mutated(value => { value.finished = false; })],
  ["finished null with success status", mutated(value => { value.finished = null; })],
  ["finished true with null status", mutated(value => { value.status = null; })],
  ["no completion marker", mutated(value => { delete value.finished; delete value.status; })],
  ["top-level error", mutated(value => { value.error = { message: "SYNTHETIC failure" }; })],
  ["execution-data error", mutated(value => { value.data.error = { message: "SYNTHETIC failure" }; })],
  ["result-data error", mutated(value => { value.data.resultData.error = { message: "SYNTHETIC failure" }; })],
  ["result-data error status", mutated(value => { value.data.resultData.status = "error"; })],
  ["known task error", mutated(value => { task(value).error = { message: "SYNTHETIC failure" }; })],
  ["known task error status", mutated(value => { task(value).executionStatus = "error"; })],
  ["known task running status", mutated(value => { task(value).executionStatus = "running"; })],
  ["known task false completion", mutated(value => { task(value).finished = false; })],
  ["missing node", mutated(value => { delete runData(value)["Ready queue"]; })],
  ["unknown eighth node", mutated(value => { runData(value).Unexpected = [structuredClone(task(value))]; })],
  ["unknown eighth error node", mutated(value => { runData(value).Unexpected = [{ error: { message: "SYNTHETIC failure" } }]; })],
  ["duplicated node execution", mutated(value => { runData(value)["Ready queue"].push(structuredClone(task(value))); })],
  ["array runData", mutated(value => { value.data.resultData.runData = []; })],
  ["invalid task-list type", mutated(value => { runData(value)["Ready queue"] = { 0: task(value), length: 1 }; })],
  ["extra output branch", mutated(value => { task(value).data.main.push([{ json: { unexpected: true } }]); })],
  ["empty extra output branch", mutated(value => { task(value).data.main.push([]); })],
  ["extra output type", mutated(value => { task(value).data.error = [[]]; })],
  ["null output branch", mutated(value => { task(value).data.main = [null]; })],
  ["invalid output item", mutated(value => { output(value)[0] = { json: null }; })],
  ["error-bearing output item", mutated(value => { output(value)[0].error = { message: "SYNTHETIC failure" }; })],
  ["empty manual trigger", mutated(value => { task(value, "Run example").data.main[0] = []; })],
  ["missing routed record", mutated(value => { output(value).pop(); })],
  ["duplicated routed record", mutated(value => { output(value).push(structuredClone(output(value)[0])); })],
  ["changed original", mutated(value => { output(value)[0].json.original.email = "changed@example.test"; })],
  ["classified statuses disagree with queues", mutated(value => { output(value, "Validate and classify").forEach(item => { item.json.status = "review"; }); })],
  ["classified source rows are identical", mutated(value => { output(value, "Validate and classify").forEach(item => { item.json.source_row = 1; }); })],
  ["classified normalization disagrees", mutated(value => { output(value, "Validate and classify")[0].json.normalized.external_id = "999"; })],
  ["queue statuses disagree with classifier", mutated(value => { output(value).forEach(item => { item.json.status = "review"; }); })],
  ["queue reason strings", mutated(value => { output(value, "Review queue").forEach(item => { item.json.reasons = item.json.reasons.join(","); }); })],
  ["queue normalization changed", mutated(value => { output(value)[0].json.normalized.full_name = "SYNTHETIC WRONG NAME"; })],
  ["queue change history changed", mutated(value => { output(value)[0].json.changes = []; })],
  ["incorrect reconciliation total", mutated(value => { output(value, "Count and reconcile")[0].json.output_count = 7; })],
  ["incorrect workflow ID", mutated(value => { value.workflowId = "AnotherWorkflow"; })],
  ["incorrect embedded workflow ID", mutated(value => { value.workflowData = { id: "AnotherWorkflow" }; })],
  ["incorrect embedded node list", mutated(value => { value.workflowData = { nodes: [] }; })],
];
for (const [name, source] of negative) test("rejects " + name, () => assert.throws(() => verify(source)));

test("CLI success emits one verified JSON summary", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "../check-execution.cjs"), fixturePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("CLI false-green regressions exit nonzero without any success summary", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "intake-checker-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["success then truncated error", "failed execution then success", "finished true with error status", "unknown eighth error node", "classified normalization disagrees"]) {
    const filename = path.join(directory, "execution.log");
    fs.writeFileSync(filename, negative.find(([label]) => label === name)[1]);
    const result = spawnSync(process.execPath, [path.join(__dirname, "../check-execution.cjs"), filename], { encoding: "utf8" });
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, "", name);
    assert.match(result.stderr, /^Execution verification failed:/, name);
  }
});
