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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-inspection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const database = path.join(dir, "intake.sqlite");
  persistIntake(database, "batch-001", records);
  return { dir, database };
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
function run(database, ...args) {
  return spawnSync(process.execPath, [script, database, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
}
function expectCode(code) { return error => { assert.equal(error.code, code, error.message); return true; }; }
function makeFifo(file) {
  const result = spawnSync("mkfifo", [file], { encoding: "utf8", timeout: 2000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
function assertFailure(result, code, json = true) {
  assert.ifError(result.error); // A subprocess timeout must fail, never count as rejection.
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  if (json) assert.equal(JSON.parse(result.stderr).error.code, code);
  else assert.match(result.stderr, new RegExp(`^${code}:`));
}
function runReplacementRace(database, replacement) {
  // Reproduce the stat/open race at the precise boundary, without timing luck.
  // The subprocess timeout also bounds this regression on the unfixed version.
  return spawnSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const { inspectIntake } = require(process.argv[1]);
    const [database, replacement] = process.argv.slice(2);
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalRead = fs.readSync;
    let descriptor, swapped = false, closed = false, reads = 0;
    fs.openSync = function (file, flags, ...rest) {
      if (file !== database) return originalOpen.call(fs, file, flags, ...rest);
      assert.equal(swapped, false);
      swapped = true;
      fs.renameSync(database, database + ".saved");
      fs.renameSync(replacement, database);
      descriptor = originalOpen.call(fs, file, flags, ...rest);
      assert.equal(typeof flags, "number");
      assert.notEqual(flags & fs.constants.O_NONBLOCK, 0);
      assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
      return descriptor;
    };
    fs.readSync = function (fd, ...rest) {
      if (fd === descriptor) reads++;
      return originalRead.call(fs, fd, ...rest);
    };
    fs.closeSync = function (fd) {
      if (fd === descriptor) closed = true;
      return originalClose.call(fs, fd);
    };
    assert.throws(() => inspectIntake(database), error => error.code === "DATABASE_UNREADABLE");
    assert.equal(swapped, true);
    assert.equal(closed, true);
    assert.equal(reads, 0);
    assert.throws(() => fs.fstatSync(descriptor), error => error.code === "EBADF");
    console.log("Rejected replacement without reading it; descriptor closed.");
  `, script, database, replacement], { encoding: "utf8", timeout: 2000 });
}

test("default index and batch summaries hide source values and show reconciled 3/4/1 totals", t => {
  const { database } = fixture(t);
  const index = inspectIntake(database);
  assert.equal(index.view, "batches");
  assert.deepEqual(index.batches[0], { batch_id: "batch-001", input_count: 8, ready_count: 3,
    review_count: 4, duplicate_count: 1, all_inputs_accounted_for: true });
  const batch = inspectIntake(database, { batch: "batch-001" });
  assert.deepEqual(batch.observed_counts, { input_count: 8, ready_count: 3, review_count: 4, duplicate_count: 1 });
  assert.equal(batch.integrity.all_inputs_accounted_for, true);
  for (const output of [JSON.stringify(index), JSON.stringify(batch), renderHuman(batch)]) {
    assert(!output.includes("Maya"));
    assert(!output.includes("maya@example.test"));
  }
  assert(batch.decisions.every(row => !Object.hasOwn(row, "original") && !Object.hasOwn(row, "normalized") && !Object.hasOwn(row, "changes")));
  assert.match(renderHuman(batch), /Source values hidden/);
});

test("explicit details preserve originals, normalized values, changes, reasons and duplicate provenance", t => {
  const { database } = fixture(t);
  const report = inspectIntake(database, { batch: "batch-001", details: true });
  assert.deepEqual(report.decisions.map(row => row.original), examples);
  assert.equal(report.decisions[0].normalized.external_id, "001");
  assert.equal(report.decisions[0].normalized.full_name, "Maya Chen");
  assert.deepEqual(report.decisions[0].changes, [{ field: "full_name", before: " Maya Chen ", after: "Maya Chen" }]);
  assert.equal(report.decisions[2].duplicate_of_row, 1);
  assert.match(report.decisions[2].explanation, /earlier normalized/);
  assert(report.decisions[1].reasons.includes("conflicting_id"));
  assert.match(renderHuman(report), /Original:.* Maya Chen /);
});

test("cross-batch duplicates and conflicts retain their first persisted batch and row references", t => {
  const { database } = fixture(t);
  persistIntake(database, "batch-002", examples);
  persistIntake(database, "batch-003", [{ ...examples[0], full_name: "A different fictional name" }]);
  const duplicates = inspectIntake(database, { batch: "batch-002", status: "duplicate", details: true });
  assert.equal(duplicates.pagination.total, 4);
  assert.deepEqual(duplicates.decisions[0].existing_record, { batch_id: "batch-001", source_row: 1 });
  assert.match(duplicates.decisions[0].explanation, /previously persisted/);
  const conflict = inspectIntake(database, { batch: "batch-003", status: "review" }).decisions[0];
  assert(conflict.reasons.includes("conflicts_with_persisted_record"));
  assert.deepEqual(conflict.existing_record, { batch_id: "batch-001", source_row: 1 });
});

test("unexpected persisted-reference fields fail without leaking values in JSON or human output", t => {
  const { database } = fixture(t);
  persistIntake(database, "batch-002", examples);
  const secret = "FICTIONAL-PRIVATE-PROVENANCE-VALUE";
  edit(database, db => {
    const row = db.prepare("SELECT record FROM decisions WHERE batch_id = ? AND source_row = 1").get("batch-002");
    const record = JSON.parse(row.record);
    record.existing_record.extra_source_value = { nested: secret };
    db.prepare("UPDATE decisions SET record = ? WHERE batch_id = ? AND source_row = 1")
      .run(JSON.stringify(record), "batch-002");
  });
  const before = snapshot(database);
  for (const details of [false, true]) {
    assert.throws(() => inspectIntake(database, { batch: "batch-002", details }), expectCode("INCOMPATIBLE_DATABASE"));
    for (const json of [false, true]) {
      const result = run(database, "--batch", "batch-002", ...(details ? ["--details"] : []), ...(json ? ["--json"] : []));
      assertFailure(result, "INCOMPATIBLE_DATABASE", json);
      assert(!result.stderr.includes(secret));
      assert(!result.stderr.includes("extra_source_value"));
    }
  }
  assert.deepEqual(snapshot(database), before);
});

test("malformed persisted references are refused without repairing stored decisions", t => {
  const { database } = fixture(t);
  persistIntake(database, "batch-002", examples);
  const original = edit(database, db => JSON.parse(db.prepare(
    "SELECT record FROM decisions WHERE batch_id = ? AND source_row = 1").get("batch-002").record));
  const invalid = [null, [], "FICTIONAL-PRIVATE-VALUE", {}, { batch_id: "batch-001" },
    { batch_id: "  ", source_row: 1 }, { batch_id: "batch-001", source_row: 0 },
    { batch_id: "batch-001", source_row: "1" }, { batch_id: "batch-001", source_row: 1.5 },
    JSON.parse('{"batch_id":"batch-001","source_row":1,"__proto__":{"private":"FICTIONAL-PRIVATE-VALUE"}}')];
  for (const reference of invalid) {
    edit(database, db => db.prepare("UPDATE decisions SET record = ? WHERE batch_id = ? AND source_row = 1")
      .run(JSON.stringify({ ...original, existing_record: reference }), "batch-002"));
    const before = snapshot(database);
    for (const details of [false, true]) {
      assert.throws(() => inspectIntake(database, { batch: "batch-002", details }), expectCode("INCOMPATIBLE_DATABASE"));
    }
    assert.deepEqual(snapshot(database), before);
  }
});

test("filtered totals stay global to the batch, with stable page-relative metadata", t => {
  const { database } = fixture(t);
  const first = inspectIntake(database, { batch: "batch-001", status: "review", limit: 2 });
  const next = inspectIntake(database, { batch: "batch-001", status: "review", limit: 2, offset: first.pagination.next_offset });
  assert.deepEqual(first.decisions.map(row => row.source_row), [2, 4]);
  assert.deepEqual(next.decisions.map(row => row.source_row), [5, 7]);
  assert.deepEqual(first.pagination, { limit: 2, offset: 0, returned: 2, total: 4, has_more: true, next_offset: 2 });
  assert.deepEqual(next.pagination, { limit: 2, offset: 2, returned: 2, total: 4, has_more: false, next_offset: null });
  assert.equal(first.summary.input_count, 8);
  assert.deepEqual(first.observed_counts, next.observed_counts);
  const end = inspectIntake(database, { batch: "batch-001", status: "review", offset: 99 });
  assert.equal(end.pagination.returned, 0);
  assert.equal(end.pagination.total, 4);
  assert.equal(end.pagination.next_offset, null);
  assert.match(renderHuman(end), /No matching decisions/);
});

test("batch index order is binary ascending, paginated, and independent of insertion order", t => {
  const { database } = fixture(t);
  for (const id of ["z", "a", "B"]) persistIntake(database, id, []);
  const first = inspectIntake(database, { limit: 2 });
  const second = inspectIntake(database, { limit: 2, offset: 2 });
  assert.deepEqual(first.batches.map(row => row.batch_id), ["B", "a"]);
  assert.deepEqual(second.batches.map(row => row.batch_id), ["batch-001", "z"]);
  assert.equal(first.pagination.total, 4);
  assert.equal(first.pagination.next_offset, 2);
  assert.equal(second.pagination.has_more, false);
});

test("all inspection views and CLI runs preserve closed database bytes, logical state and directory entries", t => {
  const { database } = fixture(t);
  persistIntake(database, "batch-002", examples);
  const before = snapshot(database);
  fs.chmodSync(database, 0o444);
  inspectIntake(database);
  for (const status of [undefined, "ready", "review", "duplicate"]) {
    inspectIntake(database, { batch: "batch-002", status, details: true, limit: 2, offset: 1 });
  }
  const json = run(database, "--batch", "batch-001", "--details", "--json");
  const human = run(database, "--batch", "batch-002", "--status", "review");
  assert.equal(json.status, 0, json.stderr);
  assert.equal(human.status, 0, human.stderr);
  assert.deepEqual(snapshot(database), before);
  assert.equal(fs.statSync(database).mode & 0o777, 0o444);
});

test("CLI JSON is deterministic, complete, parseable and keeps stderr separate", t => {
  const { database } = fixture(t);
  const args = ["--batch", "batch-001", "--status", "review", "--details", "--json"];
  const one = run(database, ...args);
  const two = run(database, ...args);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, two.stdout);
  assert.deepEqual(JSON.parse(one.stdout), inspectIntake(database, { batch: "batch-001", status: "review", details: true }));
  assert.equal(JSON.parse(one.stdout).decisions.length, 4);
});

test("empty committed batches and rolled-back first runs are inspectable without inventing records", t => {
  const { database, dir } = fixture(t, []);
  const empty = inspectIntake(database, { batch: "batch-001", status: "review", details: true });
  assert.equal(empty.summary.input_count, 0);
  assert.deepEqual(empty.decisions, []);
  const rolledBack = path.join(dir, "rollback.sqlite");
  assert.throws(() => persistIntake(rolledBack, "retry", examples, { failAfterFirstRow: true }), /rolled back/);
  assert.deepEqual(inspectIntake(rolledBack).batches, []);
  assert.throws(() => inspectIntake(rolledBack, { batch: "retry" }), expectCode("BATCH_NOT_FOUND"));
  assert.equal(persistIntake(rolledBack, "retry", examples).ready_count, 3);
  inspectIntake(rolledBack, { batch: "retry" });
  assert.equal(persistIntake(rolledBack, "retry", examples).replayed, true);
});

test("missing files, non-files and incompatible schemas are never created or migrated", t => {
  const { database, dir } = fixture(t);
  const missing = path.join(dir, "missing.sqlite");
  assert.throws(() => inspectIntake(missing), expectCode("DATABASE_NOT_FOUND"));
  assert(!fs.existsSync(missing));
  assert.throws(() => inspectIntake(dir), expectCode("DATABASE_UNREADABLE"));
  const fake = path.join(dir, "fake.sqlite");
  fs.writeFileSync(fake, "fictional non-database");
  assert.throws(() => inspectIntake(fake), expectCode("INCOMPATIBLE_DATABASE"));
  edit(database, db => db.exec("DROP TABLE decisions"));
  const bytes = fs.readFileSync(database);
  assert.throws(() => inspectIntake(database), expectCode("INCOMPATIBLE_DATABASE"));
  assert.deepEqual(fs.readFileSync(database), bytes);
  edit(database, db => assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'decisions'").get().count, 0));
});

test("FIFOs and FIFO symlinks are rejected before open and the CLI never waits for a writer", { skip: process.platform === "win32" }, t => {
  const { database, dir } = fixture(t);
  const fifo = path.join(dir, "input.fifo");
  const link = path.join(dir, "input-link.sqlite");
  makeFifo(fifo);
  fs.symlinkSync(fifo, link);
  const before = snapshot(database);
  const open = fs.openSync;
  const calls = [];
  const mock = t.mock.method(fs, "openSync", (file, ...args) => {
    calls.push(file);
    if (file === fifo || file === link) throw new Error("Non-file must be refused before open");
    return open(file, ...args);
  });
  for (const file of [fifo, link]) {
    assert.throws(() => inspectIntake(file), expectCode("DATABASE_UNREADABLE"));
  }
  mock.mock.restore();
  assert.deepEqual(calls, []);
  for (const file of [fifo, link]) {
    for (const json of [false, true]) {
      const result = spawnSync(process.execPath, [script, file, ...(json ? ["--json"] : [])],
        { encoding: "utf8", timeout: 2000 });
      assertFailure(result, "DATABASE_UNREADABLE", json);
    }
  }
  assert(fs.lstatSync(fifo).isFIFO());
  assert(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(snapshot(database), before);
});

test("a FIFO replacing a regular file between stat and open cannot block or reach header reads", { skip: process.platform === "win32" }, t => {
  const { database, dir } = fixture(t);
  const replacement = path.join(dir, "replacement.fifo");
  makeFifo(replacement);
  const bytes = fs.readFileSync(database);
  const result = runReplacementRace(database, replacement);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Rejected replacement/);
  assert(fs.lstatSync(database).isFIFO());
  assert.deepEqual(fs.readFileSync(database + ".saved"), bytes);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["intake.sqlite", "intake.sqlite.saved"]);
});

test("a different regular-file descriptor is refused even when its bytes match the prechecked file", { skip: process.platform === "win32" }, t => {
  const { database, dir } = fixture(t);
  const replacement = path.join(dir, "replacement.sqlite");
  fs.copyFileSync(database, replacement);
  const bytes = fs.readFileSync(database);
  const result = runReplacementRace(database, replacement);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Rejected replacement/);
  assert.deepEqual(fs.readFileSync(database), bytes);
  assert.deepEqual(fs.readFileSync(database + ".saved"), bytes);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["intake.sqlite", "intake.sqlite.saved"]);
});

test("descriptor-verification failures close the read-only handle and leave the database untouched", t => {
  const { database } = fixture(t);
  const before = snapshot(database);
  const open = fs.openSync;
  const stat = fs.fstatSync;
  let descriptor;
  const openMock = t.mock.method(fs, "openSync", (file, ...args) => {
    const fd = open(file, ...args);
    if (file === database) descriptor = fd;
    return fd;
  });
  const statMock = t.mock.method(fs, "fstatSync", (fd, ...args) => {
    if (fd === descriptor) throw Object.assign(new Error("FICTIONAL-PRIVATE-ERROR"), { code: "EIO" });
    return stat(fd, ...args);
  });
  assert.throws(() => inspectIntake(database), error => {
    assert.equal(error.code, "DATABASE_UNREADABLE");
    assert(!error.message.includes("FICTIONAL-PRIVATE-ERROR"));
    return true;
  });
  statMock.mock.restore();
  openMock.mock.restore();
  assert.throws(() => fs.fstatSync(descriptor), error => error.code === "EBADF");
  assert.deepEqual(snapshot(database), before);
});

test("stable symlinks to standalone regular databases remain read-only and inspectable", { skip: process.platform === "win32" }, t => {
  const { database, dir } = fixture(t);
  const link = path.join(dir, "database-link.sqlite");
  fs.symlinkSync(database, link);
  const before = snapshot(database);
  assert.deepEqual(inspectIntake(link, { batch: "batch-001" }), inspectIntake(database, { batch: "batch-001" }));
  assert.deepEqual(snapshot(database), before);
});

for (const suffix of ["-journal", "-wal", "-shm"]) test(`file and directory aliases cannot hide the target database's ${suffix} sidecar`, { skip: process.platform === "win32" }, t => {
  const { database, dir } = fixture(t);
  const realDir = path.join(dir, "real");
  fs.mkdirSync(realDir);
  const realDatabase = path.join(realDir, "intake.sqlite");
  fs.renameSync(database, realDatabase);
  const fileAlias = path.join(dir, "alias.sqlite");
  const directoryAlias = path.join(dir, "directory-alias");
  fs.symlinkSync(realDatabase, fileAlias);
  fs.symlinkSync(realDir, directoryAlias);
  const aliases = [fileAlias, path.join(directoryAlias, "intake.sqlite")];
  const sidecar = realDatabase + suffix;
  fs.writeFileSync(sidecar, `FICTIONAL-SIDECAR-${suffix}`);
  // Do not open SQLite to take this snapshot: the sidecar must remain intact.
  const capture = () => ({ database: fs.readFileSync(realDatabase), sidecar: fs.readFileSync(sidecar),
    rootEntries: fs.readdirSync(dir).sort(), targetEntries: fs.readdirSync(realDir).sort() });
  const before = capture();
  for (const input of [realDatabase, ...aliases]) {
    assert.throws(() => inspectIntake(input), expectCode("DATABASE_SIDECARS"));
    assertFailure(run(input, "--json"), "DATABASE_SIDECARS");
    assert.deepEqual(capture(), before);
  }
});

test("dangling sidecar links are rejected conservatively without resolving or changing their target", { skip: process.platform === "win32" }, t => {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const { database, dir } = fixture(t);
    const sidecar = database + suffix;
    const missingTarget = path.join(dir, "absent-sidecar-target");
    fs.symlinkSync(missingTarget, sidecar);
    const capture = () => ({ database: fs.readFileSync(database), link: fs.readlinkSync(sidecar),
      entries: fs.readdirSync(dir).sort() });
    const before = capture();
    assert.throws(() => inspectIntake(database), expectCode("DATABASE_SIDECARS"));
    assertFailure(run(database, "--json"), "DATABASE_SIDECARS");
    assert.deepEqual(capture(), before);
    assert(!fs.existsSync(missingTarget));
  }
});

test("bad JSON, wrong schema columns and bad decision shapes fail without printing source data", t => {
  const { database } = fixture(t);
  const raw = "FICTIONAL-PRIVATE-VALUE";
  edit(database, db => db.prepare("UPDATE decisions SET record = ? WHERE source_row = 1").run(raw));
  const before = snapshot(database);
  const result = run(database, "--batch", "batch-001", "--details", "--json");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "INCOMPATIBLE_DATABASE");
  assert(!result.stderr.includes(raw));
  assert.deepEqual(snapshot(database), before);
  edit(database, db => db.prepare("UPDATE decisions SET record = ? WHERE source_row = 1").run("{}"));
  assert.throws(() => inspectIntake(database, { batch: "batch-001" }), expectCode("INCOMPATIBLE_DATABASE"));
  edit(database, db => db.exec("ALTER TABLE decisions RENAME COLUMN status TO old_status"));
  assert.throws(() => inspectIntake(database), expectCode("INCOMPATIBLE_DATABASE"));
});

test("invalid summary JSON, unknown status and mismatched counts fail explicitly without repair", t => {
  const { database } = fixture(t);
  edit(database, db => db.exec("DELETE FROM decisions WHERE source_row = 8"));
  const before = snapshot(database);
  for (const options of [{}, { batch: "batch-001" }, { batch: "batch-001", status: "review" }]) {
    assert.throws(() => inspectIntake(database, options), expectCode("INCONSISTENT_COUNTS"));
  }
  assert.deepEqual(snapshot(database), before);
  edit(database, db => db.exec("UPDATE decisions SET status = 'unknown' WHERE source_row = 1"));
  assert.throws(() => inspectIntake(database), expectCode("INCOMPATIBLE_DATABASE"));
  edit(database, db => db.exec("UPDATE batches SET summary = '{not valid JSON'"));
  assert.throws(() => inspectIntake(database), expectCode("INCOMPATIBLE_DATABASE"));
});

test("unknown batches, invalid filters and unsafe page sizes fail with documented exit codes", t => {
  const { database } = fixture(t);
  assert.throws(() => inspectIntake(database, { batch: "missing" }), expectCode("BATCH_NOT_FOUND"));
  for (const options of [{ status: "review" }, { batch: "batch-001", status: "unknown" }, { details: true },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: "1e3" },
    { offset: "9007199254740992" }, { batch: "" }]) {
    assert.throws(() => inspectIntake(database, options), expectCode("INVALID_OPTIONS"));
  }
  const bad = run(database, "--limit", "101", "--json");
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, "");
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_OPTIONS");
  const unknown = run(database, "--batch", "missing", "--json");
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stderr).error.code, "BATCH_NOT_FOUND");
});

test("batch IDs are parameterized literal values, and terminal control characters are escaped", t => {
  const { database } = fixture(t);
  const id = "x'; DROP TABLE ready; --\n\u001b[31m";
  const records = [{ external_id: "synthetic", full_name: "Fictional\n\u001b[31mName", email: "test@example.test" }];
  persistIntake(database, id, records);
  const report = inspectIntake(database, { batch: id, details: true });
  assert.equal(report.batch_id, id);
  assert.deepEqual(report.decisions[0].original, records[0]);
  assert(!renderHuman(report).includes("\u001b"));
  assert(renderHuman(report).includes("\\u001b"));
  assert.equal(snapshot(database).ready.length, 4);
});

test("record and whole-report byte limits fail rather than silently truncating originals", t => {
  const { database, dir } = fixture(t, [{ external_id: "huge", full_name: "x".repeat(70 * 1024), email: "huge@example.test" }]);
  assert.throws(() => inspectIntake(database, { batch: "batch-001", details: true }), expectCode("OUTPUT_LIMIT"));
  const many = path.join(dir, "many.sqlite");
  persistIntake(many, "many", Array.from({ length: 30 }, (_, index) => ({
    external_id: String(index), full_name: "x".repeat(20 * 1024), email: "many@example.test" })));
  assert.throws(() => inspectIntake(many, { batch: "many", details: true, limit: 30 }), expectCode("OUTPUT_LIMIT"));
  assert.equal(inspectIntake(many, { batch: "many", details: true, limit: 1 }).decisions.length, 1);
  assert.equal(inspectIntake(many, { batch: "many" }).decisions.length, 20);
});

test("WAL mode and recovery sidecars are rejected before SQLite can create, recover or clean files", t => {
  const { database, dir } = fixture(t);
  edit(database, db => db.exec("PRAGMA journal_mode = WAL"));
  const before = { bytes: fs.readFileSync(database), files: fs.readdirSync(dir).sort() };
  assert.throws(() => inspectIntake(database), expectCode("UNSUPPORTED_JOURNAL_MODE"));
  assert.deepEqual({ bytes: fs.readFileSync(database), files: fs.readdirSync(dir).sort() }, before);
  edit(database, db => db.exec("PRAGMA journal_mode = DELETE"));
  fs.writeFileSync(database + "-journal", "fictional recovery sidecar");
  const bytes = fs.readFileSync(database);
  assert.throws(() => inspectIntake(database), expectCode("DATABASE_SIDECARS"));
  assert.deepEqual(fs.readFileSync(database), bytes);
  assert.equal(fs.readFileSync(database + "-journal", "utf8"), "fictional recovery sidecar");
});
