"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { persistIntake } = require("../persist-intake.cjs");
const { inspectIntake, renderHuman } = require("../inspect-intake.cjs");
const examples = require("../example-records.json");
const script = path.join(__dirname, "../inspect-intake.cjs");

function fixture(t, records = examples) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-review-summary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const database = path.join(dir, "intake.sqlite");
  persistIntake(database, "batch-001", records);
  return { database, dir };
}
function edit(database, callback) {
  const db = new DatabaseSync(database);
  try { return callback(db); } finally { db.close(); }
}
function snapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return { bytes: fs.readFileSync(database), files: fs.readdirSync(path.dirname(database)).sort(),
      schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
      batches: db.prepare("SELECT * FROM batches ORDER BY id").all(),
      decisions: db.prepare("SELECT * FROM decisions ORDER BY batch_id, source_row").all(),
      ready: db.prepare("SELECT * FROM ready ORDER BY external_id").all() };
  } finally { db.close(); }
}
function summarize(database, options = {}) { return inspectIntake(database, { reviewSummary: true, ...options }); }
function run(database, ...args) {
  return spawnSync(process.execPath, [script, database, "--review-summary", ...args],
    { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
}
function expectCode(code) { return error => { assert.equal(error.code, code, error.message); return true; }; }
function failure(database, code, ...args) {
  const result = run(database, ...args, "--json");
  assert.ifError(result.error);
  assert.equal(result.status, code === "INVALID_OPTIONS" ? 2 : 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, code);
  return result;
}
function updateDecision(database, sourceRow, callback, batch = "batch-001") {
  edit(database, db => {
    const record = JSON.parse(db.prepare("SELECT record FROM decisions WHERE batch_id = ? AND source_row = ?").get(batch, sourceRow).record);
    db.prepare("UPDATE decisions SET record = ? WHERE batch_id = ? AND source_row = ?").run(JSON.stringify(callback(record)), batch, sourceRow);
  });
}

test("review summary ranks saved reasons across batches with whole-scope denominators", t => {
  const { database } = fixture(t);
  persistIntake(database, "batch-002", examples);
  persistIntake(database, "batch-003", [{ ...examples[0], full_name: "Another fictional name" }]);
  persistIntake(database, "empty", []);
  const report = summarize(database);
  assert.equal(report.view, "review_summary");
  assert.deepEqual(report.scope, { batch_id: null });
  assert.equal(report.batch_count, 4);
  assert.equal(report.batches_with_review, 3);
  assert.deepEqual(report.observed_counts, { input_count: 17, ready_count: 3, review_count: 9, duplicate_count: 5 });
  assert.deepEqual(report.reasons, [
    { reason: "conflicting_id", review_decision_count: 4, batch_count: 2 },
    { reason: "email_format_needs_review", review_decision_count: 2, batch_count: 2 },
    { reason: "missing_email", review_decision_count: 2, batch_count: 2 },
    { reason: "conflicts_with_persisted_record", review_decision_count: 1, batch_count: 1 },
  ]);
  assert.deepEqual(report.integrity, { summary_matches_decisions: true, all_inputs_accounted_for: true });
  assert.equal(report.review_decisions_without_reasons, 0);
  assert.equal(report.review_decisions_with_unrecognized_reasons, 0);
  const single = summarize(database, { batch: "batch-003" });
  assert.deepEqual(single.scope, { batch_id: "batch-003" });
  assert.equal(single.batch_count, 1);
  assert.deepEqual(single.observed_counts, { input_count: 1, ready_count: 0, review_count: 1, duplicate_count: 0 });
  assert.deepEqual(single.reasons, [{ reason: "conflicts_with_persisted_record", review_decision_count: 1, batch_count: 1 }]);
  assert.equal(Object.hasOwn(report, "pagination"), false);
});

test("multi-reason decisions count once per bucket and batch, with explicit reasonless and unknown counts", t => {
  const { database } = fixture(t, [null, null, null]);
  const privateText = "FICTIONAL-PRIVATE-REASON\n\u001b[31m";
  updateDecision(database, 1, record => ({ ...record, reasons: ["missing_email", "missing_email", "missing_full_name", privateText, "__proto__"] }));
  updateDecision(database, 2, record => ({ ...record, reasons: ["missing_email", "unrecognized_reason"] }));
  updateDecision(database, 3, record => ({ ...record, reasons: [] }));
  const report = summarize(database);
  assert.deepEqual(report.reasons, [
    { reason: "missing_email", review_decision_count: 2, batch_count: 1 },
    { reason: "unrecognized_reason", review_decision_count: 2, batch_count: 1 },
    { reason: "missing_full_name", review_decision_count: 1, batch_count: 1 },
  ]);
  assert.equal(report.observed_counts.review_count, 3);
  assert.equal(report.review_decisions_without_reasons, 1);
  assert.equal(report.review_decisions_with_unrecognized_reasons, 2);
  assert.equal(report.counting, "distinct_review_decisions_per_reason; reasons_can_overlap");
  for (const output of [JSON.stringify(report), renderHuman(report), run(database, "--json").stdout, run(database).stdout]) {
    assert(!output.includes(privateText));
    assert(!output.includes("__proto__"));
    assert(!output.includes("\u001b"));
  }
});

test("all reason codes emitted by the current classifier and persistence writer are recognized", t => {
  const accepted = { external_id: "accepted", full_name: "Fictional Person", email: "person@example.test" };
  const { database } = fixture(t, [null, { external_id: 1, full_name: 2, email: 3, company: 4 },
    { external_id: "bad", full_name: "Fictional", email: "bad", extra: "fictional" },
    { ...accepted, external_id: "conflict" }, { ...accepted, external_id: "conflict", full_name: "Other" }, accepted]);
  persistIntake(database, "changed", [{ ...accepted, full_name: "Changed" }]);
  const report = summarize(database);
  assert.equal(report.review_decisions_with_unrecognized_reasons, 0);
  assert.deepEqual(report.reasons.map(entry => entry.reason).sort(), [
    "record_is_not_an_object", "missing_external_id", "missing_full_name", "missing_email",
    "non_text_external_id", "non_text_full_name", "non_text_email", "non_text_company",
    "email_format_needs_review", "unmapped_fields", "conflicting_id", "conflicts_with_persisted_record",
  ].sort());
});

test("summary output exposes no source values, arbitrary payload fields, or row provenance", t => {
  const secret = "FICTIONAL-PRIVATE-SOURCE";
  const { database } = fixture(t, [{ external_id: "secret-id", full_name: secret, email: "bad", private_field: secret }]);
  updateDecision(database, 1, record => ({ ...record, extra: { hidden: secret } }));
  for (const options of [{}, { batch: "batch-001" }]) {
    const report = summarize(database, options);
    for (const output of [JSON.stringify(report), renderHuman(report)]) {
      for (const hidden of [secret, "secret-id", "private_field", "original", "normalized", "source_row", "existing_record"]) {
        assert(!output.includes(hidden), hidden);
      }
    }
  }
  assert.match(renderHuman(summarize(database)), /not a count of unresolved work/);
});

test("empty, ready-only, and rolled-back databases produce complete zero-review summaries", t => {
  const { database, dir } = fixture(t, []);
  let report = summarize(database);
  assert.equal(report.batch_count, 1);
  assert.equal(report.batches_with_review, 0);
  assert.deepEqual(report.reasons, []);
  assert.equal(report.review_decisions_without_reasons, 0);
  assert.match(renderHuman(report), /No review reason buckets/);
  persistIntake(database, "ready", [examples[0]]);
  report = summarize(database);
  assert.equal(report.observed_counts.ready_count, 1);
  assert.equal(report.observed_counts.review_count, 0);
  const rolledBack = path.join(dir, "rollback.sqlite");
  assert.throws(() => persistIntake(rolledBack, "retry", examples, { failAfterFirstRow: true }), /rolled back/);
  report = summarize(rolledBack);
  assert.equal(report.batch_count, 0);
  assert.deepEqual(report.observed_counts, { input_count: 0, ready_count: 0, review_count: 0, duplicate_count: 0 });
  assert.deepEqual(report.reasons, []);
  failure(rolledBack, "BATCH_NOT_FOUND", "--batch", "retry");
});

test("summary CLI is deterministic in human and JSON form, with literal escaped batch IDs", t => {
  const { database } = fixture(t);
  const id = "x'; DROP TABLE ready; --\n\u001b[31m";
  persistIntake(database, id, [null]);
  const args = ["--batch", id, "--json"];
  const first = run(database, ...args);
  const second = run(database, ...args);
  assert.ifError(first.error);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(JSON.parse(first.stdout), summarize(database, { batch: id }));
  const human = run(database, "--batch", id);
  assert.equal(human.status, 0, human.stderr);
  assert(!human.stdout.includes("\u001b"));
  assert(human.stdout.includes("\\u001b"));
  assert.equal(human.stdout, run(database, "--batch", id).stdout);
  assert.equal(snapshot(database).ready.length, 3);
});

test("summary rejects detail, status and pagination options rather than hiding their semantics", t => {
  const { database } = fixture(t);
  for (const options of [{ details: true }, { status: "review" }, { limit: 20 }, { offset: 0 },
    { batch: "batch-001", details: true }, { reviewSummary: "true" }]) {
    assert.throws(() => summarize(database, options), expectCode("INVALID_OPTIONS"));
  }
  for (const args of [["--details"], ["--status", "review"], ["--limit", "20"], ["--offset", "0"]]) {
    failure(database, "INVALID_OPTIONS", ...args);
  }
  failure(database, "BATCH_NOT_FOUND", "--batch", "missing");
});

test("summary validates every review payload in scope, including later records, without value leaks", t => {
  const { database } = fixture(t, Array.from({ length: 21 }, () => null));
  const original = edit(database, db => db.prepare("SELECT record FROM decisions WHERE source_row = 21").get().record);
  for (const invalid of ["FICTIONAL-PRIVATE-JSON", "{}", JSON.stringify({ ...JSON.parse(original), reasons: ["missing_email", 7] }),
    JSON.stringify({ ...JSON.parse(original), existing_record: { batch_id: "b", source_row: 1, private: "FICTIONAL-PRIVATE-JSON" } })]) {
    edit(database, db => db.prepare("UPDATE decisions SET record = ? WHERE source_row = 21").run(invalid));
    const before = snapshot(database);
    assert.throws(() => summarize(database), expectCode("INCOMPATIBLE_DATABASE"));
    assert.throws(() => summarize(database, { batch: "batch-001" }), expectCode("INCOMPATIBLE_DATABASE"));
    const result = failure(database, "INCOMPATIBLE_DATABASE");
    assert(!result.stderr.includes("FICTIONAL-PRIVATE-JSON"));
    assert.deepEqual(snapshot(database), before);
  }
});

test("summary reconciles all selected batches and refuses orphan decisions globally", t => {
  const { database } = fixture(t);
  persistIntake(database, "good", [null]);
  edit(database, db => db.exec("DELETE FROM decisions WHERE batch_id = 'batch-001' AND source_row = 8"));
  const before = snapshot(database);
  assert.throws(() => summarize(database), expectCode("INCONSISTENT_COUNTS"));
  assert.throws(() => summarize(database, { batch: "batch-001" }), expectCode("INCONSISTENT_COUNTS"));
  assert.equal(summarize(database, { batch: "good" }).observed_counts.review_count, 1);
  assert.deepEqual(snapshot(database), before);
  edit(database, db => db.exec("UPDATE decisions SET status = 'unrecognized' WHERE batch_id = 'good'"));
  assert.throws(() => summarize(database, { batch: "good" }), expectCode("INCOMPATIBLE_DATABASE"));
  const clean = fixture(t, [null]).database;
  edit(clean, db => db.exec("UPDATE decisions SET batch_id = 'orphan'"));
  assert.throws(() => summarize(clean), expectCode("INCOMPATIBLE_DATABASE"));
});

test("summary rejects oversized decisions and summaries without partial results", t => {
  const { database } = fixture(t, [{ full_name: "x".repeat(70 * 1024) }]);
  const before = snapshot(database);
  failure(database, "OUTPUT_LIMIT");
  assert.deepEqual(snapshot(database), before);
  const empty = fixture(t, []).database;
  edit(empty, db => db.prepare("UPDATE batches SET summary = ?").run(JSON.stringify({ padding: "x".repeat(17 * 1024) })));
  failure(empty, "OUTPUT_LIMIT");
});

test("summary supports exactly 1000 batches and rejects a larger scope without sampling", t => {
  const { database } = fixture(t, []);
  edit(database, db => {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO batches VALUES (?, '', ?)");
    for (let index = 1; index < 1000; index++) {
      const batch_id = `empty-${index}`;
      insert.run(batch_id, JSON.stringify({ batch_id, input_count: 0, ready_count: 0, review_count: 0,
        duplicate_count: 0, all_inputs_accounted_for: true }));
    }
    db.exec("COMMIT");
  });
  assert.equal(summarize(database).batch_count, 1000);
  persistIntake(database, "over-limit", []);
  const before = snapshot(database);
  failure(database, "REVIEW_SUMMARY_LIMIT");
  assert.equal(summarize(database, { batch: "batch-001" }).batch_count, 1);
  assert.deepEqual(snapshot(database), before);
});

test("summary supports exactly 10000 review decisions and refuses a larger single batch", t => {
  const { database } = fixture(t, Array.from({ length: 10000 }, () => null));
  const report = summarize(database);
  assert.equal(report.observed_counts.review_count, 10000);
  assert(report.reasons.every(reason => reason.review_decision_count === 10000 && reason.batch_count === 1));
  edit(database, db => {
    db.exec("BEGIN");
    const record = JSON.parse(db.prepare("SELECT record FROM decisions LIMIT 1").get().record);
    record.source_row = 10001;
    db.prepare("INSERT INTO decisions VALUES ('batch-001', 10001, 'review', ?)").run(JSON.stringify(record));
    const summary = JSON.parse(db.prepare("SELECT summary FROM batches").get().summary);
    summary.input_count++; summary.review_count++;
    db.prepare("UPDATE batches SET summary = ?").run(JSON.stringify(summary));
    db.exec("COMMIT");
  });
  const before = snapshot(database);
  failure(database, "REVIEW_SUMMARY_LIMIT");
  failure(database, "REVIEW_SUMMARY_LIMIT", "--batch", "batch-001");
  assert.deepEqual(snapshot(database), before);
});

test("summary API and CLI preserve read-only DB bytes, schema, rows and entries through stable symlinks", { skip: process.platform === "win32" }, t => {
  const { database, dir } = fixture(t);
  persistIntake(database, "batch-002", examples);
  const alias = path.join(dir, "alias.sqlite");
  const directoryAlias = path.join(dir, "directory-alias");
  fs.symlinkSync(database, alias);
  fs.symlinkSync(dir, directoryAlias);
  const before = snapshot(database);
  fs.chmodSync(database, 0o444);
  for (const file of [database, alias, path.join(directoryAlias, "intake.sqlite")]) {
    assert.deepEqual(summarize(file), summarize(database));
    for (const args of [[], ["--json"], ["--batch", "batch-002", "--json"]]) {
      const result = run(file, ...args);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
  }
  assert.deepEqual(snapshot(database), before);
  assert.equal(fs.statSync(database).mode & 0o777, 0o444);
});

test("summary refuses journal sidecars through file/directory aliases without changing them", { skip: process.platform === "win32" }, t => {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const { database, dir } = fixture(t);
    const alias = path.join(dir, "alias.sqlite");
    const directoryAlias = path.join(dir, "directory-alias");
    fs.symlinkSync(database, alias);
    fs.symlinkSync(dir, directoryAlias);
    const sidecar = database + suffix;
    fs.writeFileSync(sidecar, "FICTIONAL-JOURNAL");
    const capture = () => ({ bytes: fs.readFileSync(database), sidecar: fs.readFileSync(sidecar), entries: fs.readdirSync(dir).sort() });
    const before = capture();
    for (const file of [database, alias, path.join(directoryAlias, "intake.sqlite")]) failure(file, "DATABASE_SIDECARS");
    assert.deepEqual(capture(), before);
    fs.unlinkSync(sidecar);
    fs.symlinkSync(path.join(dir, "absent"), sidecar);
    for (const file of [database, alias, path.join(directoryAlias, "intake.sqlite")]) failure(file, "DATABASE_SIDECARS");
    assert(fs.lstatSync(sidecar).isSymbolicLink());
    assert(!fs.existsSync(path.join(dir, "absent")));
    assert.deepEqual(fs.readFileSync(database), before.bytes);
  }
});

test("summary shares missing-file, FIFO and WAL refusal without creating or recovering files", t => {
  const { database, dir } = fixture(t);
  const missing = path.join(dir, "missing.sqlite");
  failure(missing, "DATABASE_NOT_FOUND");
  assert(!fs.existsSync(missing));
  if (process.platform !== "win32") {
    const fifo = path.join(dir, "input.fifo");
    const result = spawnSync("mkfifo", [fifo], { timeout: 2000, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const fifoResult = spawnSync(process.execPath, [script, fifo, "--review-summary", "--json"], { timeout: 2000, encoding: "utf8" });
    assert.ifError(fifoResult.error);
    assert.equal(fifoResult.status, 1);
    assert.equal(JSON.parse(fifoResult.stderr).error.code, "DATABASE_UNREADABLE");
  }
  edit(database, db => db.exec("PRAGMA journal_mode = WAL"));
  const before = { bytes: fs.readFileSync(database), entries: fs.readdirSync(dir).sort() };
  failure(database, "UNSUPPORTED_JOURNAL_MODE");
  assert.deepEqual({ bytes: fs.readFileSync(database), entries: fs.readdirSync(dir).sort() }, before);
});
