"use strict";

// Inspection deliberately does not import persist-intake: opening a report must
// never create tables, migrate a schema, replay input, or reclassify a decision.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const { parseArgs } = require("node:util");

const STATUSES = ["ready", "review", "duplicate"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_REVIEW_BATCHES = 1000;
const MAX_REVIEW_DECISIONS = 10000;
// A fixed vocabulary keeps arbitrary stored strings out of the aggregate view.
// These are reading labels only: the inspector never reruns the classifier.
const REVIEW_REASONS = new Set([
  "record_is_not_an_object", "missing_external_id", "missing_full_name", "missing_email",
  "non_text_external_id", "non_text_full_name", "non_text_email", "non_text_company",
  "email_format_needs_review", "unmapped_fields", "conflicting_id", "conflicts_with_persisted_record",
]);
const HELP = `Usage: node inspect-intake.cjs DATABASE [options]

List committed batches, or inspect the saved decisions in one batch.
  --batch ID                 Inspect one batch (IDs are exact, case-sensitive)
  --review-summary           Rank review reasons across all batches, or --batch
  --status ready|review|duplicate  Filter that batch's decisions
  --details                  Include original/normalized values and changes
  --limit N                  Page size, 1..100 (default 20)
  --offset N                 Zero-based offset (default 0)
  --json                     Emit a machine-readable report
  --help                     Show this help

Read-only. No creation, migrations, reclassification, or external services.
Only standalone rollback-journal SQLite files are supported; see the guide.
Reports contain source values. Use fictional or appropriately protected data.`;

class InspectionError extends Error {
  constructor(code, message) { super(message); this.name = "InspectionError"; this.code = code; }
}
function fail(code, message) { throw new InspectionError(code, message); }
function incompatible(detail) {
  fail("INCOMPATIBLE_DATABASE", `Incompatible intake database: ${detail}. No changes were made.`);
}
function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    fail("INVALID_OPTIONS", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail("INVALID_OPTIONS", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}
function optionsFor({ batch, status, details = false, limit, offset, reviewSummary = false } = {}) {
  if (typeof reviewSummary !== "boolean") fail("INVALID_OPTIONS", "reviewSummary must be a boolean.");
  if (reviewSummary && (status !== undefined || details || limit !== undefined || offset !== undefined)) {
    fail("INVALID_OPTIONS", "--review-summary cannot be combined with --status, --details, --limit, or --offset.");
  }
  if (batch !== undefined && (typeof batch !== "string" || !batch.trim())) {
    fail("INVALID_OPTIONS", "batch must be a nonempty exact batch ID.");
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    fail("INVALID_OPTIONS", "status must be ready, review, or duplicate.");
  }
  if (status !== undefined && batch === undefined) fail("INVALID_OPTIONS", "--status requires --batch.");
  if (typeof details !== "boolean") fail("INVALID_OPTIONS", "details must be a boolean.");
  if (details && batch === undefined) fail("INVALID_OPTIONS", "--details requires --batch.");
  return { batch, status, details, reviewSummary, limit: boundedInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit"),
    offset: boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset") };
}
function sidecarExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    // A dangling symlink is still a sidecar directory entry. Only an absent
    // entry is safe; unexpected stat failures must fail closed as unreadable.
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function checkFile(databaseFile) {
  if (typeof databaseFile !== "string" || !databaseFile || databaseFile === ":memory:") {
    fail("INVALID_OPTIONS", "An existing SQLite database file is required.");
  }
  let handle;
  try {
    // SQLite resolves symlinks itself. Use the same canonical path for every
    // preflight and for SQLite so an alias cannot hide the target's sidecars.
    const canonicalFile = fs.realpathSync(databaseFile);
    // Refuse devices, directories and FIFOs before open: a blocking read-only
    // open of a FIFO would otherwise wait indefinitely for a writer. The path
    // can still change after stat, so open nonblocking and verify the actual
    // descriptor's type and identity before attempting any header read.
    const expected = fs.statSync(canonicalFile, { bigint: true });
    if (!expected.isFile()) fail("DATABASE_UNREADABLE", "The database path must be a regular file.");
    handle = fs.openSync(canonicalFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const actual = fs.fstatSync(handle, { bigint: true });
    if (!actual.isFile()) fail("DATABASE_UNREADABLE", "The database path must be a regular file.");
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
      fail("DATABASE_UNREADABLE", "The database path changed during inspection. Retry with a stable standalone file.");
    }
    const header = Buffer.alloc(100);
    const bytes = fs.readSync(handle, header, 0, header.length, 0);
    if (bytes < 100 || !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
      incompatible("not a SQLite database");
    }
    // A mode=ro WAL connection can create -shm/-wal files. immutable=1 would
    // instead ignore uncheckpointed commits. Reject both compromises before
    // opening SQLite; this companion's writer uses the default journal mode.
    if (header[18] === 2 || header[19] === 2) {
      fail("UNSUPPORTED_JOURNAL_MODE", "WAL databases are not supported by this read-only inspector. Ask the database owner for a consistent standalone SQLite snapshot in DELETE journal mode; do not copy only the main file from a live WAL database.");
    }
    // Do not attempt recovery or cleanup of a possibly interrupted writer.
    if (["-journal", "-wal", "-shm"].some(suffix => sidecarExists(canonicalFile + suffix))) {
      fail("DATABASE_SIDECARS", "SQLite journal/sidecar files are present. Finish or recover the writer first, or inspect a consistent standalone snapshot. Do not delete sidecars to bypass this check.");
    }
    return canonicalFile;
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    if (error.code === "ENOENT") fail("DATABASE_NOT_FOUND", "Database not found. Inspection does not create a database; persist a batch first.");
    fail("DATABASE_UNREADABLE", "The database file could not be read. Check its path and read permissions.");
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
function validateSchema(db) {
  const expected = {
    batches: { id: "TEXT", digest: "TEXT", summary: "TEXT" },
    decisions: { batch_id: "TEXT", source_row: "INTEGER", status: "TEXT", record: "TEXT" },
    ready: { external_id: "TEXT", normalized: "TEXT", batch_id: "TEXT", source_row: "INTEGER" },
  };
  for (const [table, columns] of Object.entries(expected)) {
    const entry = db.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table);
    if (!entry || entry.type !== "table") incompatible(`missing ${table} table`);
    // table comes exclusively from the constant allowlist above.
    const actual = new Map(db.prepare(`PRAGMA table_info(${table})`).all().map(column => [column.name, column.type.toUpperCase()]));
    if (Object.entries(columns).some(([name, type]) => actual.get(name) !== type)) {
      incompatible(`unexpected ${table} columns`);
    }
  }
}
function parseStored(value, label) {
  if (typeof value !== "string") incompatible(`invalid ${label}`);
  try { return JSON.parse(value); }
  catch { incompatible(`invalid JSON in ${label}`); }
}
function summaryFor(row) {
  if (row.summary === null) fail("OUTPUT_LIMIT", "A stored batch summary exceeds the 16 KiB inspection limit.");
  const summary = parseStored(row.summary, "batch summary");
  if (!summary || typeof row.id !== "string" || !row.id.trim() || summary.batch_id !== row.id || typeof summary.all_inputs_accounted_for !== "boolean" ||
      ["input_count", ...STATUSES.map(status => status + "_count")].some(key =>
        !Number.isSafeInteger(summary[key]) || summary[key] < 0)) incompatible("unexpected batch summary fields");
  return Object.fromEntries(["batch_id", "input_count", "ready_count", "review_count", "duplicate_count", "all_inputs_accounted_for"]
    .map(key => [key, summary[key]]));
}
function pageFor(total, options, returned) {
  const hasMore = options.offset < total && returned < total - options.offset;
  return { limit: options.limit, offset: options.offset, returned, total,
    has_more: hasMore, next_offset: hasMore ? options.offset + returned : null };
}
function observedFor(db, batchId, summary) {
  const groups = db.prepare("SELECT status, COUNT(*) AS count FROM decisions WHERE batch_id = ? GROUP BY status").all(batchId);
  const observed = { input_count: 0, ready_count: 0, review_count: 0, duplicate_count: 0 };
  for (const group of groups) {
    if (!STATUSES.includes(group.status)) incompatible("unknown decision status");
    observed[group.status + "_count"] = group.count;
    observed.input_count += group.count;
  }
  if (!Object.keys(observed).every(key => observed[key] === summary[key]) || !summary.all_inputs_accounted_for ||
      summary.input_count !== summary.ready_count + summary.review_count + summary.duplicate_count) {
    fail("INCONSISTENT_COUNTS", "Stored batch totals do not reconcile with its decisions. No report or repair was performed.");
  }
  return observed;
}
function decisionFor(row, details) {
  if (row.record === null) fail("OUTPUT_LIMIT", "A stored decision exceeds the 64 KiB inspection limit. Its original values were not truncated or printed.");
  const record = parseStored(row.record, "decision");
  if (!record || Array.isArray(record) || !Number.isSafeInteger(record.source_row) || record.source_row < 1 ||
      record.source_row !== row.source_row || record.status !== row.status || !STATUSES.includes(record.status) ||
      !Object.hasOwn(record, "original") || !record.normalized || typeof record.normalized !== "object" ||
      Array.isArray(record.normalized) || !Array.isArray(record.changes) || !Array.isArray(record.reasons) ||
      record.reasons.some(reason => typeof reason !== "string")) incompatible("unexpected decision fields");
  if (record.duplicate_of_row !== undefined && (!Number.isSafeInteger(record.duplicate_of_row) ||
      record.duplicate_of_row < 1 || record.duplicate_of_row >= record.source_row)) incompatible("invalid duplicate reference");
  let existingRecord;
  if (record.existing_record !== undefined) {
    const reference = record.existing_record;
    if (!reference || typeof reference !== "object" || Array.isArray(reference) ||
        Object.keys(reference).some(key => key !== "batch_id" && key !== "source_row") ||
        typeof reference.batch_id !== "string" || !reference.batch_id.trim() ||
        !Number.isSafeInteger(reference.source_row) || reference.source_row < 1) {
      incompatible("invalid persisted record reference");
    }
    // Provenance is visible without --details. Never pass through a stored
    // object that might contain additional source values or nested payloads.
    existingRecord = { batch_id: reference.batch_id, source_row: reference.source_row };
  }
  let explanation = "Passed the stored intake checks and was accepted into the ready destination.";
  if (record.status === "review") explanation = record.reasons.join(", ") || "Stored for manual review.";
  if (record.status === "duplicate") {
    explanation = record.existing_record ? "Matches a previously persisted normalized record." : "Matches an earlier normalized record in this batch.";
  }
  if (details) return { ...record, ...(existingRecord === undefined ? {} : { existing_record: existingRecord }), explanation };
  return { source_row: record.source_row, status: record.status, reasons: record.reasons, explanation,
    ...(record.duplicate_of_row === undefined ? {} : { duplicate_of_row: record.duplicate_of_row }),
    ...(existingRecord === undefined ? {} : { existing_record: existingRecord }) };
}

function reviewSummaryFor(db, options) {
  const scoped = options.batch !== undefined;
  const parameters = scoped ? [options.batch] : [];
  const batchWhere = scoped ? "WHERE id = ?" : "";
  const batchCount = db.prepare(`SELECT COUNT(*) AS count FROM batches ${batchWhere}`).get(...parameters).count;
  if (scoped && batchCount === 0) fail("BATCH_NOT_FOUND", "Batch not found. Use the batch index to find an exact committed ID.");
  if (batchCount > MAX_REVIEW_BATCHES) {
    fail("REVIEW_SUMMARY_LIMIT", "Review summaries support at most 1000 batches. Use --batch to inspect one committed batch; no partial summary was produced.");
  }
  // A global summary must not silently omit decisions without a committed batch.
  if (!scoped && db.prepare(`SELECT 1 FROM decisions d WHERE NOT EXISTS
    (SELECT 1 FROM batches b WHERE b.id = d.batch_id) LIMIT 1`).get()) {
    incompatible("decision without a committed batch");
  }
  const observed = { input_count: 0, ready_count: 0, review_count: 0, duplicate_count: 0 };
  let batchesWithReview = 0;
  const batches = db.prepare(`SELECT id,
    CASE WHEN length(CAST(summary AS BLOB)) <= ? THEN summary ELSE NULL END AS summary
    FROM batches ${batchWhere} ORDER BY id COLLATE BINARY`).iterate(MAX_SUMMARY_BYTES, ...parameters);
  for (const batch of batches) {
    const counts = observedFor(db, batch.id, summaryFor(batch));
    for (const key of Object.keys(observed)) {
      observed[key] += counts[key];
      if (!Number.isSafeInteger(observed[key])) incompatible("unsafe aggregate count");
    }
    if (counts.review_count > 0) batchesWithReview++;
  }
  if (observed.review_count > MAX_REVIEW_DECISIONS) {
    fail("REVIEW_SUMMARY_LIMIT", "Review summaries support at most 10000 review decisions. Use --batch to narrow the scope if possible; no partial summary was produced.");
  }
  const reasons = new Map();
  let withoutReasons = 0;
  let withUnrecognizedReasons = 0;
  let reviewed = 0;
  const where = scoped ? "WHERE status = 'review' AND batch_id = ?" : "WHERE status = 'review'";
  const rows = db.prepare(`SELECT batch_id, source_row, status,
    CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record ELSE NULL END AS record
    FROM decisions ${where} ORDER BY batch_id COLLATE BINARY, source_row ASC`).iterate(MAX_RECORD_BYTES, ...parameters);
  for (const row of rows) {
    // Decode every review decision in scope, even when it has no known reasons.
    // The normal validator also checks provenance; source values never enter the report.
    const decision = decisionFor(row, false);
    reviewed++;
    if (decision.reasons.length === 0) withoutReasons++;
    const hasUnknown = decision.reasons.some(reason => !REVIEW_REASONS.has(reason));
    if (hasUnknown) withUnrecognizedReasons++;
    const buckets = new Set(decision.reasons.map(reason => REVIEW_REASONS.has(reason) ? reason : "unrecognized_reason"));
    for (const reason of buckets) {
      let entry = reasons.get(reason);
      if (!entry) {
        entry = { reason, review_decision_count: 0, batch_count: 0, lastBatch: undefined };
        reasons.set(reason, entry);
      }
      entry.review_decision_count++;
      if (entry.lastBatch !== row.batch_id) { entry.batch_count++; entry.lastBatch = row.batch_id; }
    }
  }
  if (reviewed !== observed.review_count) incompatible("unexpected review decision count");
  const ranked = [...reasons.values()].map(({ lastBatch, ...entry }) => entry)
    .sort((a, b) => b.review_decision_count - a.review_decision_count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  return { format_version: 1, view: "review_summary", scope: { batch_id: options.batch ?? null },
    batch_count: batchCount, batches_with_review: batchesWithReview, observed_counts: observed,
    integrity: { summary_matches_decisions: true, all_inputs_accounted_for: true },
    review_decisions_without_reasons: withoutReasons,
    review_decisions_with_unrecognized_reasons: withUnrecognizedReasons,
    counting: "distinct_review_decisions_per_reason; reasons_can_overlap",
    order: "review_decision_count_descending_then_reason_binary_ascending", reasons: ranked };
}

function inspectIntake(databaseFile, inputOptions = {}) {
  const options = optionsFor(inputOptions);
  const canonicalFile = checkFile(databaseFile);
  let db;
  try {
    db = new DatabaseSync(canonicalFile, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN;");
    validateSchema(db);
    let report;
    if (options.reviewSummary) {
      report = reviewSummaryFor(db, options);
    } else if (options.batch === undefined) {
      const total = db.prepare("SELECT COUNT(*) AS count FROM batches").get().count;
      const rows = db.prepare(`SELECT id, CASE WHEN length(CAST(summary AS BLOB)) <= ? THEN summary ELSE NULL END AS summary
        FROM batches ORDER BY id COLLATE BINARY LIMIT ? OFFSET ?`).all(MAX_SUMMARY_BYTES, options.limit, options.offset);
      report = { format_version: 1, view: "batches", order: "batch_id_binary_ascending",
        pagination: pageFor(total, options, rows.length), batches: rows.map(row => {
          const summary = summaryFor(row);
          observedFor(db, row.id, summary);
          return summary;
        }) };
    } else {
      const batch = db.prepare(`SELECT id, CASE WHEN length(CAST(summary AS BLOB)) <= ? THEN summary ELSE NULL END AS summary
        FROM batches WHERE id = ?`).get(MAX_SUMMARY_BYTES, options.batch);
      if (!batch) fail("BATCH_NOT_FOUND", "Batch not found. Use the batch index to find an exact committed ID.");
      const summary = summaryFor(batch);
      const observed = observedFor(db, options.batch, summary);
      const where = options.status === undefined ? "batch_id = ?" : "batch_id = ? AND status = ?";
      const parameters = options.status === undefined ? [options.batch] : [options.batch, options.status];
      const rows = db.prepare(`SELECT source_row, status,
        CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record ELSE NULL END AS record
        FROM decisions WHERE ${where} ORDER BY source_row ASC LIMIT ? OFFSET ?`)
        .all(MAX_RECORD_BYTES, ...parameters, options.limit, options.offset);
      const total = options.status === undefined ? observed.input_count : observed[options.status + "_count"];
      report = { format_version: 1, view: "batch", batch_id: options.batch, summary, observed_counts: observed,
        integrity: { summary_matches_decisions: true, all_inputs_accounted_for: true },
        filters: { status: options.status ?? null }, details: options.details, order: "source_row_ascending",
        pagination: pageFor(total, options, rows.length), decisions: rows.map(row => decisionFor(row, options.details)) };
    }
    if (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_REPORT_BYTES) {
      fail("OUTPUT_LIMIT", "Report exceeds 1 MiB. Reduce --limit to inspect a smaller page; no partial report was printed.");
    }
    return report;
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    if (error.code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(error.message)) {
      fail("DATABASE_BUSY", "Database is busy. Retry inspection after the writer finishes.");
    }
    fail("DATABASE_UNREADABLE", "The SQLite database could not be inspected. It may be corrupt, inaccessible, or incompatible. No changes were made.");
  } finally {
    // Closing the connection ends the read transaction. No COMMIT, write PRAGMA,
    // schema initialization, or recovery operation is performed by the inspector.
    if (db) db.close();
  }
}

function renderHuman(report) {
  // JSON escaping keeps newlines, ANSI escape sequences, and other control
  // characters in stored user input from changing the terminal presentation.
  const value = input => JSON.stringify(input);
  if (report.view === "review_summary") {
    const count = report.observed_counts;
    const lines = ["Review reason summary", report.scope.batch_id === null ? "Scope: all committed batches" : `Scope: batch ${value(report.scope.batch_id)}`,
      `Batches: ${report.batch_count}; with review decisions: ${report.batches_with_review}`,
      `Reconciled totals: ${count.input_count} input | ${count.ready_count} ready | ${count.review_count} review | ${count.duplicate_count} duplicate`,
      "Counts are distinct review decisions per reason. Reasons overlap, so their counts are not a total."];
    for (const reason of report.reasons) {
      lines.push(`${value(reason.reason)}: ${reason.review_decision_count} review decision${reason.review_decision_count === 1 ? "" : "s"} in ${reason.batch_count} batch${reason.batch_count === 1 ? "" : "es"}`);
    }
    if (report.reasons.length === 0) lines.push("No review reason buckets in this scope.");
    lines.push(`Review decisions without reasons: ${report.review_decisions_without_reasons}`,
      `Review decisions with unrecognized reasons: ${report.review_decisions_with_unrecognized_reasons}`,
      "Source values, row references, and unrecognized reason text are hidden.",
      "These are saved review decisions, not a count of unresolved work. Inspection does not resolve or reclassify them.");
    return lines.join("\n");
  }
  const page = report.pagination;
  const lines = [report.view === "batches" ? "Committed intake batches" : `Batch ${value(report.batch_id)}`];
  if (report.view === "batches") {
    for (const batch of report.batches) lines.push(`${value(batch.batch_id)}: ${batch.input_count} input | ${batch.ready_count} ready | ${batch.review_count} review | ${batch.duplicate_count} duplicate | accounted for: ${batch.all_inputs_accounted_for}`);
  } else {
    const count = report.observed_counts;
    lines.push(`Stored totals: ${report.summary.input_count} input | ${report.summary.ready_count} ready | ${report.summary.review_count} review | ${report.summary.duplicate_count} duplicate`,
      `Observed totals: ${count.input_count} input | ${count.ready_count} ready | ${count.review_count} review | ${count.duplicate_count} duplicate`,
      `Counts match: ${report.integrity.summary_matches_decisions}; all inputs accounted for: ${report.integrity.all_inputs_accounted_for}`,
      `Status filter: ${report.filters.status ?? "all"}`);
    for (const row of report.decisions) {
      lines.push("", `Row ${row.source_row} | ${row.status}`, `  Why: ${value(row.explanation)}`,
        `  Reasons: ${value(row.reasons)}`);
      if (report.details) lines.push(`  Original: ${value(row.original)}`, `  Normalized: ${value(row.normalized)}`,
        `  Changes: ${value(row.changes)}`);
      if (row.unmapped_fields) lines.push(`  Unmapped fields: ${value(row.unmapped_fields)}`);
      if (row.duplicate_of_row !== undefined) lines.push(`  Duplicate of row: ${value(row.duplicate_of_row)}`);
      if (row.existing_record) lines.push(`  Existing record: ${value(row.existing_record)}`);
    }
    if (!report.details) lines.push("", "Source values hidden. Add --details to include originals, normalized values, and changes.");
  }
  if (page.returned === 0) lines.push(report.view === "batches" ? "No batches on this page." : "No matching decisions on this page.");
  lines.push("", `Page: ${page.returned} of ${page.total} matching ${report.view === "batches" ? "batches" : "decisions"}; offset ${page.offset}; limit ${page.limit}`);
  if (page.has_more) lines.push(`More results: repeat the same command with --offset ${page.next_offset}.`);
  return lines.join("\n");
}

function main(args) {
  let json = args.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      batch: { type: "string" }, status: { type: "string" }, limit: { type: "string" },
      offset: { type: "string" }, details: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
      "review-summary": { type: "boolean" },
    } });
    json = Boolean(values.json);
    if (values.help) { console.log(HELP); return; }
    if (positionals.length !== 1) fail("INVALID_OPTIONS", HELP);
    const report = inspectIntake(positionals[0], { ...values, reviewSummary: values["review-summary"] });
    console.log(json ? JSON.stringify(report, null, 2) : renderHuman(report));
  } catch (error) {
    const code = error instanceof InspectionError ? error.code : "INVALID_OPTIONS";
    const message = error instanceof InspectionError ? error.message : "Invalid arguments. Run with --help for usage.";
    console.error(json ? JSON.stringify({ error: { code, message } }) : `${code}: ${message}`);
    process.exitCode = code === "INVALID_OPTIONS" ? 2 : 1;
  }
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { inspectIntake, renderHuman, InspectionError };
