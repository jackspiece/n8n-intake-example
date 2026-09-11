"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { classifyRecords } = require("./classify.cjs");
const examples = require("./example-records.json");

const makeCode = (id, name, position, jsCode) => ({
  parameters: { mode: "runOnceForAllItems", jsCode },
  id, name, type: "n8n-nodes-base.code", typeVersion: 2, position,
});

const nodes = [
  {
    parameters: {}, id: "start", name: "Run example",
    type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 300],
  },
  makeCode("example", "Fictional intake records", [240, 300],
    "const records = " + JSON.stringify(examples, null, 2) + ";\nreturn records.map(json => ({ json }));"),
  makeCode("classify", "Validate and classify", [500, 300],
    classifyRecords.toString() + "\n\nreturn classifyRecords($input.all().map(item => item.json))\n  .map((json, index) => ({ json, pairedItem: { item: index } }));"),
  makeCode("ready", "Ready queue", [800, 40],
    'return $input.all().filter(item => item.json.status === "ready");'),
  makeCode("review", "Review queue", [800, 240],
    'return $input.all().filter(item => item.json.status === "review");'),
  makeCode("duplicates", "Duplicate log", [800, 440],
    'return $input.all().filter(item => item.json.status === "duplicate");'),
  makeCode("audit", "Count and reconcile", [800, 640], [
    "const rows = $input.all().map(item => item.json);",
    'const ready = rows.filter(row => row.status === "ready");',
    'const review = rows.filter(row => row.status === "review");',
    'const duplicate = rows.filter(row => row.status === "duplicate");',
    "const outputCount = ready.length + review.length + duplicate.length;",
    'if (outputCount !== rows.length) throw new Error("An input has no recognized queue");',
    "return [{ json: {",
    "  input_count: rows.length, output_count: outputCount,",
    "  ready_count: ready.length, review_count: review.length, duplicate_count: duplicate.length,",
    "  ready_ids: ready.map(row => row.normalized.external_id),",
    "  review_rows: review.map(row => row.source_row),",
    "  duplicate_pairs: duplicate.map(row => ({ source_row: row.source_row, duplicate_of_row: row.duplicate_of_row })),",
    "  all_inputs_accounted_for: outputCount === rows.length,",
    "} }];",
  ].join("\n")),
];

const to = node => ({ node, type: "main", index: 0 });
const workflow = {
  id: "IntakeDemo260911",
  name: "Intake example: preserve, check, route",
  active: false,
  nodes,
  connections: {
    "Run example": { main: [[to("Fictional intake records")]] },
    "Fictional intake records": { main: [[to("Validate and classify")]] },
    "Validate and classify": { main: [[
      to("Ready queue"), to("Review queue"), to("Duplicate log"), to("Count and reconcile"),
    ]] },
  },
  settings: { executionOrder: "v1" },
  pinData: {},
  tags: [],
};
const output = path.join(__dirname, "workflow.json");
fs.writeFileSync(output, JSON.stringify(workflow, null, 2) + "\n");
console.log(JSON.stringify({ file: "workflow.json", nodes: nodes.length, sample_records: examples.length }));
