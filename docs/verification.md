# Verification

[← Back to the project](../README.md)

## Classifier checks

With Node.js 24:

```sh
npm test
```

The original six local tests exercise the classifier and its record handling. Four companion tests exercise local SQLite persistence, process-restart replay, cross-batch duplicates/conflicts, transactional rollback/retry and batch-ID misuse. No package installation is needed. See the [persistence demo](persistence-demo.md) for the precise scope.

Twenty-six [inspection tests](inspection-guide.md) verify saved decisions, pagination, privacy boundaries, read-only file/alias handling, and error behavior. Fifteen [review-summary tests](review-summary.md) verify complete-scope aggregation, overlapping reason counts, unknown-reason privacy, scan limits, and unchanged database bytes/schema/rows/sidecars. The [execution-checker tests](../test/execution.test.cjs) add 101 checks for parsing, terminal states, node/output structure, complete record reconciliation, and CLI exit behavior. These local tests include replay of a [recorded successful n8n log](../test/fixtures/README.md) and deliberately corrupted synthetic cases. The full local suite totals **152 tests**. They do not launch n8n or a new GitHub Actions run.

`npm run build` regenerates `workflow.json` from the same classifier and example inputs.

## Actual n8n execution

The [GitHub workflow](../.github/workflows/check.yml) also installs n8n **2.38.7** with Node **24.18.0** on Ubuntu, imports the exported JSON into a temporary database and executes it.

[check-execution.cjs](../check-execution.cjs) validates one complete successful execution, exactly the seven expected nodes, the full classified records, the three queues, and reconciliation derived from those queues. Run it on the **raw output from one CLI invocation**, not a combined job log:

```sh
n8n execute --id=IntakeDemo260911 --rawOutput > execution.log 2>&1
node check-execution.cjs execution.log
```

The CI shell separately requires the n8n command to exit successfully before invoking the checker. The checker emits one JSON summary with `verified: true` only after every check passes; failures exit nonzero and emit no success summary.

### Supported log contract

- Exactly one top-level execution result is required. Pretty, compact, indented, LF, and CRLF JSON are supported. Multiple results are rejected regardless of order or whether both succeeded. An execution-shaped child inside a wrapper or array is not promoted to a result.
- Ordinary startup/shutdown prose and complete unrelated JSON diagnostics can surround the result. Diagnostic JSON can be embedded in prose. Informational `status` fields alone are not execution candidates. Bracketed ISO timestamps and ANSI-colored prose are supported. The recorded Python-runner warning remains accepted.
- JSON-looking objects/arrays are scanned as whole containers with quote and escape handling. Malformed or truncated containers, duplicate keys (including escaped spellings of the same key), unquoted object-key/colon wrappers, and isolated unmatched JSON punctuation fail closed. Bare prose such as `Stopped {okay}` is allowed; unknown JSON-looking diagnostic formats must be reviewed rather than silently skipped. The execution JSON itself must end at a line boundary, EOF, or another JSON record, which will still be checked.
- A candidate has an execution-specific field such as `finished`, `workflowId`, `workflowData`, `resultData`, `runData`, or `data.resultData`. Every present `finished`, `status`, and `executionStatus` field at the execution, result, or task boundary must agree with success. The execution must contain at least `finished: true` or `status: "success"`; the other field and task statuses may be absent for compatible older envelopes. Explicit null/false/non-success statuses fail. Error payloads at these boundaries and error-bearing or failure-status JSON diagnostics fail, as do explicit error/fatal or workflow-execution-failure prose diagnostics.
- The node-name set must match the seven-node example exactly. Every node must execute once, have no error, and expose exactly one `main` output branch. The manual trigger must emit one empty item. Extra nodes, tasks, output types, or output branches, even empty branches, are rejected.
- Every classified JSON record must match the local classifier's complete expected result, including its original, normalization, changes, reasons, status, and source row. Each queue must equal its classified subset, with every record accounted for exactly once. The reconciliation node must equal totals derived from those validated queues and the independent eight-record, 3/4/1 baseline. Optional workflow identity, when supplied, must match this example.

The checker is a contract check for this fixed fictional example, not a general-purpose n8n log parser or proof of log provenance. Adapting the workflow or changing log formats can require updating the contract and its positive fixtures. Synthetic false-green regressions demonstrate defects in the earlier checker; they do not demonstrate that any previous actual n8n execution or CI run failed.

The [verified run from September 11, 2026](https://github.com/jackspiece/n8n-intake-example/actions/runs/34645429890) completed successfully:

| Check | Recorded result |
| --- | --- |
| Classifier tests | 6 passed |
| Executed workflow nodes | 7 |
| Input records | 8 |
| Ready / review / duplicate | 3 / 4 / 1 |
| Records accounted for | 8 |

The execution output is in the job log. The README badge links to the current workflow status; the dated run above is the recorded baseline.
