"use strict";

// Local-only persistence demonstration. The importable n8n workflow stays small.
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { classifyRecords } = require("./classify.cjs");

function persistIntake(databaseFile, batchId, records, { failAfterFirstRow = false } = {}) {
  if (typeof batchId !== "string" || !batchId.trim()) throw new Error("A nonempty batch ID is required");
  if (!Array.isArray(records)) throw new Error("Input must be a JSON array");
  const digest = createHash("sha256").update(JSON.stringify(records)).digest("hex");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, digest TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ready (external_id TEXT PRIMARY KEY, normalized TEXT NOT NULL,
        batch_id TEXT NOT NULL, source_row INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (batch_id TEXT NOT NULL, source_row INTEGER NOT NULL,
        status TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (batch_id, source_row));
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = db.prepare("SELECT digest, summary FROM batches WHERE id = ?").get(batchId);
      if (prior) {
        if (prior.digest !== digest) throw new Error("Batch ID already exists with different input; use a new ID");
        db.exec("COMMIT");
        return { ...JSON.parse(prior.summary), replayed: true };
      }
      const summary = { batch_id: batchId, input_count: records.length, ready_count: 0,
        review_count: 0, duplicate_count: 0, all_inputs_accounted_for: false };
      const lookup = db.prepare("SELECT normalized, batch_id, source_row FROM ready WHERE external_id = ?");
      const insertReady = db.prepare("INSERT INTO ready VALUES (?, ?, ?, ?)");
      const insertDecision = db.prepare("INSERT INTO decisions VALUES (?, ?, ?, ?)");
      const rows = classifyRecords(records);
      // Inspect earlier committed batches before inserting any new ready records.
      // This also sends every copy in an incoming conflicting group to review.
      for (const row of rows) {
        if (row.status === "review") continue;
        const existing = lookup.get(row.normalized.external_id);
        if (!existing) continue;
        row.existing_record = { batch_id: existing.batch_id, source_row: existing.source_row };
        delete row.duplicate_of_row;
        if (existing.normalized === JSON.stringify(row.normalized)) {
          row.status = "duplicate";
        } else {
          row.status = "review";
          row.reasons.push("conflicts_with_persisted_record");
        }
      }
      for (const row of rows) {
        if (row.status === "ready") {
          insertReady.run(row.normalized.external_id, JSON.stringify(row.normalized), batchId, row.source_row);
        }
        insertDecision.run(batchId, row.source_row, row.status, JSON.stringify(row));
        summary[row.status + "_count"]++;
        if (failAfterFirstRow) throw new Error("Injected failure after first row; transaction rolled back");
      }
      summary.all_inputs_accounted_for = summary.input_count ===
        summary.ready_count + summary.review_count + summary.duplicate_count;
      if (!summary.all_inputs_accounted_for) throw new Error("Row accounting failed");
      db.prepare("INSERT INTO batches VALUES (?, ?, ?)").run(batchId, digest, JSON.stringify(summary));
      db.exec("COMMIT");
      return { ...summary, replayed: false };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    const [databaseFile, batchId, inputFile, flag] = process.argv.slice(2);
    if (!databaseFile || !batchId || !inputFile || process.argv.length > 6 ||
        (flag && flag !== "--fail-after-first-row")) {
      throw new Error("Usage: node persist-intake.cjs DATABASE BATCH_ID INPUT_JSON [--fail-after-first-row]");
    }
    console.log(JSON.stringify(persistIntake(databaseFile, batchId,
      JSON.parse(fs.readFileSync(inputFile, "utf8")), { failAfterFirstRow: Boolean(flag) }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { persistIntake };
