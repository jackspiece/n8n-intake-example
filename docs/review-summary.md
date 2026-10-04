# Prioritize recurring review reasons

`--review-summary` answers **which saved review reasons affect the most decisions, and how many batches contain them?** It summarizes all committed batches, or one exact batch, using the same local read-only inspector. It does not rerun classification, resolve decisions, edit originals, or contact a destination.

The report describes historical saved decisions. This example has no resolution state, so the counts are **not an unresolved-work queue**. Reimporting the same problematic records under a new batch ID adds more saved decisions. They count separately; they are not deduplicated people or customers.

## Synthetic demonstration

Use Node.js 24 from the repository root, with a fresh directory:

```sh
mkdir demo-local-review
node persist-intake.cjs demo-local-review/intake.sqlite batch-001 example-records.json
node persist-intake.cjs demo-local-review/intake.sqlite batch-002 example-records.json
node -e 'const fs = require("node:fs"); const rows = require("./example-records.json"); fs.writeFileSync("demo-local-review/conflict.json", JSON.stringify([{ ...rows[0], full_name: "Another fictional name" }]));'
node persist-intake.cjs demo-local-review/intake.sqlite batch-003 demo-local-review/conflict.json

# Complete cross-batch view; source values and row references stay hidden.
node inspect-intake.cjs demo-local-review/intake.sqlite --review-summary

# Machine-readable view of just the persisted conflict batch.
node inspect-intake.cjs demo-local-review/intake.sqlite --review-summary --batch batch-003 --json
```

The complete human summary is:

```text
Review reason summary
Scope: all committed batches
Batches: 3; with review decisions: 3
Reconciled totals: 17 input | 3 ready | 9 review | 5 duplicate
Counts are distinct review decisions per reason. Reasons overlap, so their counts are not a total.
"conflicting_id": 4 review decisions in 2 batches
"email_format_needs_review": 2 review decisions in 2 batches
"missing_email": 2 review decisions in 2 batches
"conflicts_with_persisted_record": 1 review decision in 1 batch
Review decisions without reasons: 0
Review decisions with unrecognized reasons: 0
Source values, row references, and unrecognized reason text are hidden.
These are saved review decisions, not a count of unresolved work. Inspection does not resolve or reclassify them.
```

The single-batch JSON report has `scope.batch_id: "batch-003"`, one batch, one input/review decision, and one `conflicts_with_persisted_record` bucket. The accepted version from `batch-001` remains unchanged. To inspect its actual saved evidence separately, use the existing batch view with an explicit `--details` request.

## Counts and scope

```text
node inspect-intake.cjs DATABASE --review-summary [--batch ID] [--json]
```

- Without `--batch`, scope is every committed batch in this database snapshot. With it, the scope is that exact, case-sensitive ID. A missing ID is an error. JSON represents the global scope as `scope.batch_id: null`.
- `observed_counts` includes **all input, ready, review, and duplicate decisions in scope**, not only the reason rows displayed. Every scoped batch's saved counters must reconcile with its stored decision statuses. The global view also refuses orphan decisions with no committed batch.
- Each reason's `review_decision_count` counts a decision once, even if its saved reason array repeats that reason. `batch_count` counts distinct scoped batches containing that reason.
- A decision with multiple reasons contributes to multiple buckets. Do not sum bucket counts to get total review decisions; use `observed_counts.review_count`.
- `review_decisions_without_reasons` counts saved review rows whose reason array is empty. They are not silently dropped or assigned an invented reason.
- Reasons sort by affected decision count descending, then reason code in binary ascending order. Zero-count buckets are omitted. Empty databases, empty batches, and scopes with no review decisions return valid complete reports.
- `--status`, `--details`, `--limit`, and `--offset` are invalid in summary mode. There is no pagination, sampling, source-value reveal, or arbitrary reason filter. The existing index and batch inspection commands retain their behavior.
- The CommonJS API is `inspectIntake(databaseFile, { reviewSummary: true, batch })`, with `batch` optional. The report has `format_version: 1` and `view: "review_summary"`.

## Unknown reasons and privacy

Only the companion's fixed known reason codes appear verbatim: `record_is_not_an_object`, `missing_external_id`, `missing_full_name`, `missing_email`, `non_text_external_id`, `non_text_full_name`, `non_text_email`, `non_text_company`, `email_format_needs_review`, `unmapped_fields`, `conflicting_id`, and `conflicts_with_persisted_record`.

Any other saved string is grouped into `unrecognized_reason`, without copying that string into the report. Multiple unknown strings on one decision count once in that bucket. `review_decisions_with_unrecognized_reasons` gives the same affected-decision count explicitly. This includes future codes and empty strings; it does not treat them as successful checks. A non-string reason, malformed review payload, or invalid provenance fails the entire report with a value-free error, rather than being silently omitted.

The aggregate view never includes originals, normalized values, changes, unmapped field names, arbitrary extra payload fields, or source-row references. A single-batch report still displays the selected batch ID, JSON-escaped in human output. Counts and known reason codes can reveal operational information, so this is **not an anonymization guarantee**. Keep real databases and reports protected; public demonstrations should use fictional data.

## Read-only and scan boundaries

The summary shares the inspector's canonical-path, regular-file/descriptor checks, sidecar/WAL rejection, SQLite `readOnly`, `query_only`, and single read transaction. It does not import the persistence writer or alter schema, database bytes, originals, ready records, or decisions. File and directory aliases cannot hide target-sidecar entries. Use a stable standalone snapshot in DELETE journal mode; see the [inspection safety boundaries](inspection-guide.md#read-only-and-compatibility-boundaries).

A report supports at most **1,000 batches and 10,000 review decisions** in its selected scope. Exceeding either bound returns `REVIEW_SUMMARY_LIMIT`, exit 1, with no partial report. Narrow to one batch when possible. A single batch exceeding 10,000 reviews cannot be summarized by this command; use the existing paginated inspection view to examine its decisions. Limits do not claim constant query time on arbitrarily large databases.

Every scoped batch summary is reconciled, and every scoped review decision is decoded and validated, including records beyond the usual 20-row page. The existing 16 KiB stored-summary, 64 KiB stored-decision, and 1 MiB report limits still apply. Oversized stored values produce `OUTPUT_LIMIT`; nothing is truncated. Processing uses row iterators rather than retaining all review payloads.

This is not a full corruption audit. Ready/duplicate payload JSON and accepted-record contents are not decoded by the aggregate view, and a single-batch summary does not validate other batches. The count checks do validate statuses for all decisions in each selected batch. Errors leave standard output empty; `--json` writes the existing structured error format to standard error. Runtime diagnostics may also appear on standard error on Node versions where SQLite remains experimental.

## Verification

```sh
npm test
npm run build
git diff --exit-code -- workflow.json
```

The 15 new summary tests cover cross-batch and exact-batch denominators, all emitted reason codes, deterministic ranking, duplicate and overlapping reasons, reasonless reviews, unknown-reason text hiding, empty states, SQL parameterization, terminal escaping, option conflicts, later-row malformed payloads, orphan decisions, exact scan boundaries, and the shared read-only protections. Snapshot comparisons include closed DB bytes, schema, all tables, and directory entries. Sidecar fixtures remain unchanged, including target-sidecars through file/directory aliases and dangling links. The full local suite has 152 tests, including 101 execution-checker tests. Build output remains the same seven-node workflow; an actual n8n execution remains a separate check.
