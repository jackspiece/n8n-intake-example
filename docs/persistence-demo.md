# Local persistence and recovery demo

This is a synthetic, local end-to-end companion to the seven-node n8n workflow. It uses the same classifier and Node 24's built-in SQLite driver, with no credentials or paid service. It does not turn the manual workflow into a live CRM integration.

## Run, replay, and recover

From the repository root, use a fresh directory for each demonstration:

```sh
mkdir demo-local
node persist-intake.cjs demo-local/intake.sqlite batch-001 example-records.json
node persist-intake.cjs demo-local/intake.sqlite batch-001 example-records.json
node persist-intake.cjs demo-local/intake.sqlite batch-002 example-records.json
```

The first run commits 3 ready, 4 review and 1 duplicate. The same batch ID and exact JSON representation return the saved result with `replayed: true`, with no additional rows. A new batch of the same records records 0 ready, 4 review and 4 duplicates against the stored IDs.

To demonstrate recovery against a separate database:

```sh
node persist-intake.cjs demo-local/recovery.sqlite retry-001 example-records.json --fail-after-first-row
# Expected exit 1: the inserted row and decisions are rolled back.
node persist-intake.cjs demo-local/recovery.sqlite retry-001 example-records.json
```

The retry commits the complete batch. `npm test` checks the stored rows, original data, process restarts, exact replays, changed batch-ID rejection, cross-batch duplicates/conflicts and the injected rollback. Node may emit an experimental warning for its SQLite API.

## Persistence rules and limits

- One SQLite transaction commits the batch digest, all classification decisions and ready records. Uncommitted partial work is rolled back on error. The tables may exist after a failed first run, but contain no partial batch.
- A reused batch ID must carry the same `JSON.stringify` input digest, including order and source values. Reordered object keys can therefore require a new ID; this is deliberately a strict replay check, not semantic JSON canonicalization.
- Identical normalized IDs from earlier batches become duplicates with the original batch/row reference. A changed version goes to review with `conflicts_with_persisted_record`; the earlier stored record is left intact for a human to reconcile. Within-batch conflicting groups retain the classifier's existing all-to-review rule.
- SQLite serializes writers with `BEGIN IMMEDIATE` and a five-second busy timeout. A caller receiving a timeout can retry the same batch. Multi-host scaling, migrations, schema corruption recovery, retention, privacy controls and destination delivery are outside this example.
- The transaction covers only this database. It does **not** make an email, CRM call or other external effect exactly-once. A real integration needs a destination idempotency key or a transactional outbox with delivery/reconciliation rules.
- The supplied fixture is fictional. Do not commit database files or use private customer records in public test artifacts.

The [existing execution check](verification.md) separately tests the actual n8n runtime. This local persistence demo does not claim to execute SQLite nodes inside n8n.
