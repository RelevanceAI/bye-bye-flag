# Release Notes

## [v0.1.3](https://github.com/RelevanceAI/bye-bye-flag/pull/3)

Fixes worktree lifecycle edge cases by canonicalizing `/tmp` vs `/private/tmp` paths, pruning stale git worktree metadata, and preventing workspace deletion when per-repo worktree cleanup fails.

## [v0.1.2](https://github.com/RelevanceAI/bye-bye-flag/pull/2)

Refactors agent invocation to a cleaner provider-agnostic contract and fixes same-agent parse-retry for session-based CLIs (e.g. Claude session ID reuse).

## [v0.1.1](https://github.com/RelevanceAI/bye-bye-flag/pull/1)

Makes runs fail closed if PR discovery fails, preventing unsafe worktree cleanup or duplicate PR creation under partial visibility.
