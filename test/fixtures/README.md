# Recorded execution fixture

`n8n-2.38.7-success.log` is the `execution.log` printed by the **Show execution diagnostics** step in the successful [September 11, 2026 run](https://github.com/jackspiece/n8n-intake-example/actions/runs/34645429890), [job 103414952228](https://github.com/jackspiece/n8n-intake-example/actions/runs/34645429890/job/103414952228). That job used n8n **2.38.7**, Node **24.18.0**, and repository commit `76d92fa5eea35de57cafed427e505964f6549729`.

The log was retrieved read-only from the existing GitHub Actions job on October 4, 2026. Only the CLI diagnostic-step output is included. GitHub's per-line timestamps were removed, trailing whitespace/final blank lines were trimmed, and the execution's ephemeral `data.resumeToken` value was replaced with `[redacted]`. The JSON shape, seven node outputs, task statuses, execution status, and CLI diagnostics are otherwise retained. It contains the repository's eight fictional example records, not real intake records.

The Python task-runner startup warning is part of the successful observed log. The JavaScript runner registered and all seven tasks completed successfully; a checker must not mistake any occurrence of the word “Failed” for a workflow failure.

This is a historical compatibility fixture. Replaying it validates the checker against that recorded output; it does not execute n8n or prove that a new workflow run has happened. The generated failure cases in `../execution.test.cjs` are synthetic mutations and do not establish that the historical run failed.
