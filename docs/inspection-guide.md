# Inspect persisted intake batches

The local inspector answers: **what was committed, which rows need review, and why?** It reads the SQLite companion's saved decisions without replaying inputs, re-running classification, or changing the database. No n8n installation, credentials, package installation, or external service is needed.

Use Node.js 24 and the existing [persistence demo](persistence-demo.md). The seven-node importable workflow is unchanged.

## Try it with fictional records

From the repository root, create a fresh demo database:

```sh
mkdir -p demo-local
node persist-intake.cjs demo-local/inspect.sqlite batch-001 example-records.json
node persist-intake.cjs demo-local/inspect.sqlite batch-002 example-records.json

# List committed batches. Original values are hidden by default.
node inspect-intake.cjs demo-local/inspect.sqlite

# Find the first two review decisions, including their saved reasons.
node inspect-intake.cjs demo-local/inspect.sqlite --batch batch-001 --status review --limit 2

# Continue the same filtered page, revealing the source and normalized values.
node inspect-intake.cjs demo-local/inspect.sqlite --batch batch-001 --status review --limit 2 --offset 2 --details

# Read cross-batch duplicate provenance in machine-readable form.
node inspect-intake.cjs demo-local/inspect.sqlite --batch batch-002 --status duplicate --details --json
```

The first batch shows **3 ready, 4 review, and 1 duplicate**. The second has **0 ready, 4 review, and 4 duplicates**; its duplicates point to the first batch's saved rows. A later batch that changes an already stored ID shows `conflicts_with_persisted_record` and that same original batch/row reference.

No command above resolves a review decision or changes an accepted record. The reviewer can compare the saved values and then choose a separate, authorized next step.

To prioritize recurring cleanup causes across these batches, use `node inspect-intake.cjs demo-local/inspect.sqlite --review-summary`. The [review-summary guide](review-summary.md) explains the distinct-decision counts, scope, privacy, and bounded scan. This aggregate mode does not show source values or row references.

## Commands and output

```text
node inspect-intake.cjs DATABASE [--batch ID] [--status ready|review|duplicate]
    [--details] [--limit N] [--offset N] [--json]
node inspect-intake.cjs DATABASE --review-summary [--batch ID] [--json]
```

- With no `--batch`, the index lists committed batch IDs and saved counters. IDs sort in SQLite binary ascending order, not by date or insertion order.
- With `--batch`, the report includes the stored counters, independently counted decisions, reconciliation results, and one page of saved decisions. IDs are exact and case-sensitive; they are bound as SQL parameters.
- `--status` requires `--batch` and accepts exactly one of `ready`, `review`, or `duplicate`. Filtering changes the page's matching total, not the whole-batch counters.
- Batch decisions sort by numeric `source_row` ascending. `--offset` is zero-based. Each page includes `returned`, `total`, `has_more`, and `next_offset`. Use the same filters for the next page. Beyond the last result, the page is empty and still reports the matching total.
- The default page size is 20; `--limit` accepts 1–100. `--offset` must be a nonnegative safe integer.
- The default per-batch view shows row, status, explanation, reason codes, and duplicate/persisted-record references. `--details` explicitly adds the complete saved `original`, `normalized`, `changes`, and any unmapped fields. Nothing is silently truncated.
- Persisted-record references contain exactly `batch_id` and `source_row`. Unexpected reference fields are rejected as incompatible, including with `--details`, rather than copied into a report or silently discarded.
- The explanation is a reading aid derived from the saved status. Reason codes, normalized values, and provenance come from the persisted decision; inspection does not recompute classification.
- `--json` emits one deterministic JSON report to standard output. It includes `format_version: 1`, a view name, filters where applicable, sort order, and pagination. There are no timestamps or machine-specific paths. Successful empty pages are valid JSON reports with an empty results array.
- Human output JSON-escapes stored strings, including control characters, so a stored newline or ANSI escape cannot rewrite the terminal display.
- `--review-summary` selects an aggregate view instead of the paginated index or decisions view. It accepts an optional exact `--batch` and `--json`, but rejects status, detail, and pagination options. Its scope is complete or the command fails; there is no sampled or partial summary.

### Example filtered JSON fields

For `--batch batch-001 --status review --limit 2 --json`, the full JSON report contains:

```json
{
  "observed_counts": {
    "input_count": 8,
    "ready_count": 3,
    "review_count": 4,
    "duplicate_count": 1
  },
  "filters": { "status": "review" },
  "pagination": {
    "limit": 2,
    "offset": 0,
    "returned": 2,
    "total": 4,
    "has_more": true,
    "next_offset": 2
  }
}
```

The two decision rows on that page are source rows 2 and 4. Offset 2 returns source rows 5 and 7. Whole-batch counters remain 8/3/4/1 on both pages.

## Read-only and compatibility boundaries

The inspector opens an **existing regular file** with SQLite's `readOnly` option and also enables connection-local `query_only`. A read transaction keeps the counter and decision queries consistent within a report. It never imports the persistence writer, initializes tables, migrates schema, writes a PRAGMA to disk, or replays an input batch. A missing database path is an error and does not create a file.

Before reading the file header, it resolves file and directory symlinks to a canonical path, checks that path's file type, opens a read-only nonblocking descriptor, then checks that descriptor's type and device/inode identity. FIFOs (including links to FIFOs), directories, and a replacement observed between that precheck and open are refused without reading their contents. A failed descriptor check closes the handle. Sidecar checks and SQLite use that same canonical path, so aliases cannot hide the target database's journal, WAL, or SHM entries, including dangling sidecar links. This preflight is not a lock on directory entries: SQLite subsequently opens the path itself, so keep the database path and its parent directory stable throughout inspection.

Use a quiescent, standalone database produced by this companion's default rollback-journal mode. **WAL databases and files with journal/sidecar files are rejected before SQLite is opened.** SQLite read-only WAL connections can create sidecars; opening an immutable main file could instead omit uncheckpointed commits. The inspector does neither. Ask the database owner for a consistent standalone SQLite snapshot in DELETE journal mode. Do not copy only the main file of a live WAL database or delete sidecars to bypass the check. No recovery or checkpoint operation is performed by inspection.

The three expected tables and their required column types must exist. Returned batches' counters must reconcile with the stored decisions, including when using a status filter. Selected decision payloads and provenance are checked before display. Schema incompatibility, malformed selected JSON, unknown status, and inconsistent counters fail explicitly. This is not a full-database corruption audit: the paginated views do not fully decode unselected batch contents or decisions outside the selected page. Review summaries reconcile every batch and validate every review payload in their scope, but do not decode ready/duplicate payloads or audit accepted-record contents.

Pagination is deterministic for unchanged data. Separate commands are separate snapshots; inserting or changing batches between calls can move index offsets. Inspect a fixed snapshot when paging through an audit.

### Bounded output

Besides the 100-row page maximum, a stored decision is limited to 64 KiB, a stored summary to 16 KiB, and a pretty-printed JSON report to 1 MiB. Oversized payloads produce `OUTPUT_LIMIT` before printing any report. A whole-report limit can be handled by reducing `--limit`; an oversized individual record is deliberately refused even with a one-row page. These are output safeguards, not a promise of constant query time on arbitrarily large databases.

### Errors and exit codes

- Exit **0**: a complete report, including empty pages, or `--help`.
- Exit **2**: invalid arguments, status, page size, or offset (`INVALID_OPTIONS`).
- Exit **1**: database or report error. Codes include `DATABASE_NOT_FOUND`, `DATABASE_UNREADABLE`, `DATABASE_BUSY`, `BATCH_NOT_FOUND`, `INCOMPATIBLE_DATABASE`, `INCONSISTENT_COUNTS`, `UNSUPPORTED_JOURNAL_MODE`, `DATABASE_SIDECARS`, `OUTPUT_LIMIT`, and `REVIEW_SUMMARY_LIMIT`.

Errors go to standard error; standard output stays empty. With `--json`, the inspector's error is `{"error":{"code":"…","message":"…"}}`. Error messages do not quote stored source values or raw SQLite errors. Node itself may emit runtime diagnostics to standard error on versions where its SQLite API is experimental.

## Privacy and verification

The fixtures use fictional `example.test` addresses. Default summaries hide source values but still expose batch IDs, reason codes, and provenance; they are **not anonymized exports**. Explicit detail output includes the full originals and any unknown source fields. Keep databases and reports appropriately protected, and do not paste real customer records or private reports into public issues. Inspection neither uploads nor transmits the database.

```sh
npm test
npm run build
```

The inspection tests verify first- and later-batch counters/provenance, default value hiding, explicit detail fidelity, stable filters/pages, empty states, deterministic JSON, SQL parameterization, escaped terminal controls, size bounds, precise errors, and WAL/sidecar refusal. Privacy regressions reject unexpected or malformed reference fields without exposing their values in human or JSON errors, with or without details. POSIX subprocess fixtures bound FIFO and deterministic stat/open replacement checks to two seconds; a timeout is a test failure, not a successful rejection. The tests also check descriptor cleanup, stable regular-file symlinks, and target-sidecar refusal through file and directory aliases, and conservative rejection of dangling sidecar links. They compare closed database bytes, schema, every table's rows, and directory entries before and after API and CLI inspection, including a read-only file. Review-summary tests additionally cover complete-scope denominators, overlapping/deduplicated reasons, unknown reasons without text exposure, exact scan boundaries, and aggregate read-only behavior. The full suite has 152 tests, including 101 execution-checker tests and the unchanged classifier, replay, conflict, and injected rollback tests. Build output must remain byte-identical to the original `workflow.json`; the inspector adds no workflow nodes.

The actual n8n runtime check remains a separate baseline described in [Verification](verification.md). The inspector tests do not claim to execute n8n.
