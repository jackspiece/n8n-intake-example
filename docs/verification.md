# Verification

[← Back to the project](../README.md)

## Classifier checks

With Node.js 24:

```sh
npm test
```

The six local tests exercise the classifier and its record handling. No package installation is needed.

`npm run build` regenerates `workflow.json` from the same classifier and example inputs.

## Actual n8n execution

The [GitHub workflow](../.github/workflows/check.yml) also installs n8n **2.38.7** with Node **24.18.0** on Ubuntu, imports the exported JSON into a temporary database and executes it.

[check-execution.cjs](../check-execution.cjs) validates all seven nodes, the three queues, the retained original records and the reconciliation count.

The [verified run from September 11, 2026](https://github.com/jackspiece/n8n-intake-example/actions/runs/34645429890) completed successfully:

| Check | Recorded result |
| --- | --- |
| Classifier tests | 6 passed |
| Executed workflow nodes | 7 |
| Input records | 8 |
| Ready / review / duplicate | 3 / 4 / 1 |
| Records accounted for | 8 |

The execution output is in the job log. The README badge links to the current workflow status; the dated run above is the recorded baseline.
