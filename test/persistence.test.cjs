"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { persistIntake } = require("../persist-intake.cjs");
const examples = require("../example-records.json");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, database: path.join(dir, "intake.sqlite") };
}
function read(database, query) {
  const db = new DatabaseSync(database);
  try { return db.prepare(query).all().map(row => ({ ...row })); }
  finally { db.close(); }
}

test("CLI persists across process restarts, replays once, and retains every original", t => {
  const { database } = fixture(t);
  const run = () => spawnSync(process.execPath, [path.join(__dirname, "../persist-intake.cjs"),
    database, "synthetic-001", path.join(__dirname, "../example-records.json")], { encoding: "utf8", timeout: 10000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { batch_id: "synthetic-001", input_count: 8,
    ready_count: 3, review_count: 4, duplicate_count: 1, all_inputs_accounted_for: true, replayed: false });
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).replayed, true);
  assert.equal(read(database, "SELECT * FROM batches").length, 1);
  assert.equal(read(database, "SELECT * FROM ready").length, 3);
  const decisions = read(database, "SELECT record FROM decisions ORDER BY source_row").map(row => JSON.parse(row.record));
  assert.deepEqual(decisions.map(row => row.original), examples);
});

test("a different batch deduplicates persisted IDs and quarantines changed versions", t => {
  const { database } = fixture(t);
  persistIntake(database, "first", examples);
  const same = persistIntake(database, "same-records-new-batch", examples);
  assert.deepEqual([same.ready_count, same.review_count, same.duplicate_count], [0, 4, 4]);
  const changed = { ...examples[0], full_name: "A different fictional name" };
  const conflict = persistIntake(database, "changed", [changed, changed]);
  assert.deepEqual([conflict.ready_count, conflict.review_count, conflict.duplicate_count], [0, 2, 0]);
  const decisions = read(database, "SELECT record FROM decisions WHERE batch_id = 'changed'").map(row => JSON.parse(row.record));
  assert(decisions.every(row => row.reasons.includes("conflicts_with_persisted_record")));
  assert(decisions.every(row => row.existing_record.batch_id === "first"));
  assert.equal(read(database, "SELECT * FROM ready").length, 3);
});

test("a partial write rolls back and the exact batch can be safely retried", t => {
  const { database } = fixture(t);
  assert.throws(() => persistIntake(database, "retry", examples, { failAfterFirstRow: true }), /rolled back/);
  for (const table of ["ready", "decisions", "batches"]) assert.equal(read(database, `SELECT * FROM ${table}`).length, 0);
  assert.equal(persistIntake(database, "retry", examples).ready_count, 3);
  assert.equal(persistIntake(database, "retry", examples).replayed, true);
});

test("batch ID reuse with changed data fails without changing committed state", t => {
  const { database } = fixture(t);
  persistIntake(database, "fixed-id", examples);
  const before = read(database, "SELECT * FROM decisions ORDER BY source_row");
  assert.throws(() => persistIntake(database, "fixed-id", []), /different input/);
  assert.deepEqual(read(database, "SELECT * FROM decisions ORDER BY source_row"), before);
});
