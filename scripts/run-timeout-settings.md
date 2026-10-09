# Resolve the deadline immediately before axis dispatch

The reviewer has read-only tools, not a shell. Use the `Run timeout settings` paths in your brief to read the current settings with `read`. These are absolute main-repo/user paths, not paths in your isolated worktree. This step runs immediately before each call to `axis-axes.js`, even if you read these files earlier.

1. Read the user settings file and the project settings file. `project: null` means there is no project layer. A missing file is an empty layer. For other read failures or malformed JSON, stop and request the orchestrator's help. If the paths are absent from your brief, request them; do not substitute worktree paths or a remembered deadline.
2. In each JSON document, look for `mattImplementFlow.agentTimeoutMs`. A valid value is a JSON number that is an integer from `1` to `2147483647`. Ignore invalid values and report the ignored scope/value to the orchestrator. `0`, `false`, strings, and fractional milliseconds are invalid.
3. Choose the valid project value, else the valid user value, else `14400000` (4 hours). This mirrors `scripts/flow-config-core.js` → `resolveRunTimeoutDetailed`.
4. Pass the chosen number as `args.timeoutMs` to `axis-axes.js`. The script passes it explicitly to both children. Give the children only this number, not the settings contents. Do not reuse your own launch value: the user may have changed settings since you started.

This is a new-child launch setting. It does not change any running child's deadline and does not override retained resume behavior. The two axes launched together share this resolution; changes after their launch apply to the next dispatch.
