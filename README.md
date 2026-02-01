# bye-bye-flag

Remove stale feature flags from codebases using AI.

`bye-bye-flag` uses Claude Code to automatically find and remove feature flag conditionals, clean up dead code, and create pull requests.

## Prerequisites

- **Node.js 24+** (native TypeScript support)
- **git**
- **[Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code)**: `npm install -g @anthropic-ai/claude-code`
- **[GitHub CLI](https://cli.github.com/)**: Required for creating PRs (not needed for `--dry-run`)

## Installation

```bash
git clone https://github.com/RelevanceAI/bye-bye-flag.git
cd bye-bye-flag
nvm use
pnpm install

# Create .env file with your configuration
cp .env.example .env
# Edit .env with your PostHog API key and project IDs
```

## Directory Structure

Set up your repos directory with the following structure:

```
my-repos/
  bye-bye-flag.json    # Config file (required)
  CONTEXT.md           # Optional context for the AI
  repo1/               # Git repository
  repo2/               # Git repository (can have 1 or more repos)
```

## Usage

```bash
# Remove a flag, keeping the enabled code path
pnpm start remove --flag=enable-dashboard --keep=enabled --repos-dir=/path/to/my-repos

# Dry run to preview changes without creating a PR
pnpm start remove --flag=enable-dashboard --keep=enabled --repos-dir=/path/to/my-repos --dry-run

# Dry run with worktree preserved for manual inspection
pnpm start remove --flag=enable-dashboard --keep=enabled --repos-dir=/path/to/my-repos --dry-run --keep-worktree
```

## Options

| Option | Description |
|--------|-------------|
| `--flag=<key>` | The feature flag key to remove (required) |
| `--keep=<branch>` | Which code path to keep: `enabled` or `disabled` (required) |
| `--repos-dir=<path>` | Path to directory containing bye-bye-flag.json and repo subdirectories (required) |
| `--dry-run` | Preview changes without creating a PR |
| `--keep-worktree` | Keep the worktree after completion for manual inspection |

## How It Works

1. **Scaffold**: Creates git worktrees with a fresh branch (`remove-flag/<flag-key>`) for each repo
2. **Search**: Finds all usages of the flag key (including variations like camelCase, SCREAMING_SNAKE_CASE)
3. **Remove**: Removes flag conditionals, keeping the specified code path
4. **Clean up**: Removes dead code, unused imports, and orphaned files
5. **Verify**: Runs typecheck, lint, and tests
6. **PR**: Commits changes and creates a draft pull request for each repo with changes

The agent runs in git worktrees, which isolates all file changes from your main repositories.

## Idempotency & Resuming

The tool is designed to be idempotent and safe to run multiple times:

- **Open PRs block re-runs**: If a PR already exists for a flag, the tool will refuse to run and point you to the existing PR.
- **Closed/merged PRs allow re-runs**: If a PR was merged or closed (without being declined), you can run the tool again to create a fresh PR.
- **Declined PRs**: If a PR is closed because the flag removal was rejected, add `[DECLINED]` to the PR title. This prevents future removal attempts for that flag.
- **Worktrees are preserved**: After creating a PR, the worktree is kept for resuming the Claude session. Worktrees are automatically cleaned up when their PR is merged or closed.

### Resuming a Session

If you need to make changes or continue working on a PR, the PR description includes a resume command:

```bash
cd /tmp/bye-bye-flag-worktrees/remove-flag-my-flag && claude --resume <session-id>
```

This lets you continue the Claude Code session with full context of what was already done.

## Configuration

Create a `bye-bye-flag.json` in your repos directory:

```json
{
  "shellInit": "source ~/.nvm/nvm.sh && nvm use",
  "repos": {
    "my-api": {
      "setup": ["pnpm install", "pnpm run codegen"]
    },
    "my-frontend": {
      "shellInit": "source ~/.asdf/asdf.sh",
      "setup": ["pnpm install"]
    }
  }
}
```

- `shellInit` (optional): Default command to run before each shell command (setup and Claude)
- `repos.<name>.shellInit` (optional): Override shellInit for a specific repo
- `repos.<name>.setup`: Setup commands for the repo (can chain with `&&` for commands that need to run in sequence)

## Context Files

You can provide additional context to the agent by placing markdown files in your repos directory:

- `CLAUDE.md` - Instructions for Claude (coding standards, patterns to follow)
- `CONTEXT.md` - General context about how the repositories relate

These files are automatically included in the prompt.

## Environment Variables

Create a `.env` file (copy from `.env.example`):

```bash
# Custom worktree location (default: /tmp/bye-bye-flag-worktrees)
WORKTREE_BASE_PATH=/path/to/worktrees

# PostHog integration (required for fetching stale flags)
POSTHOG_API_KEY=phx_xxx

# Single project:
POSTHOG_PROJECT_ID=12345

# Or multiple projects (comma-separated, e.g., dev and prod):
POSTHOG_PROJECT_IDS=12345,67890
```

## Fetching Stale Flags (PostHog)

The PostHog fetcher finds flags that are candidates for removal.

**Criteria for stale flags:**
- Updated more than 30 days ago (configurable)
- Either 0% or 100% rollout (no partial rollouts or complex targeting)
- No payload
- No multivariate variants
- If flag exists in multiple projects, must be consistent across all

**Inactive flags** are also included with `keepBranch: "disabled"`.

```bash
# Fetch stale flags
pnpm run fetch:posthog

# Custom stale threshold (days)
pnpm run fetch:posthog -- --stale-days=60

# Show all flags with their status (not just stale ones)
pnpm run fetch:posthog -- --show-all
```

Output is JSON to stdout:
```json
[
  {
    "key": "old-feature",
    "keepBranch": "enabled",
    "reason": "100% rollout for 45 days",
    "projects": ["12345", "67890"]
  },
  {
    "key": "killed-feature",
    "keepBranch": "disabled",
    "reason": "Inactive for 90 days",
    "projects": ["12345"]
  }
]
```

This can be piped to other tools or used to drive the removal agent.

## Example Output

```
Checking prerequisites...
Prerequisites OK

============================================================
Removing flag: enable-new-dashboard (keep: enabled)
Repos directory: ./my-repos
============================================================

Fetching latest from origin for my-api...
Creating worktree for my-api on branch remove-flag/enable-new-dashboard...
  Running: pnpm install
  Running: pnpm run codegen

Fetching latest from origin for my-frontend...
Creating worktree for my-frontend on branch remove-flag/enable-new-dashboard...
  Running: pnpm install

Workspace created at /tmp/bye-bye-flag-worktrees/remove-flag-enable-new-dashboard with 2 repos

Found 2 repos:
  - my-api
  - my-frontend

Checking if flag "enable-new-dashboard" exists in codebase...
Flag found. Launching Claude Code to remove it...

[Claude] Searching for flag usages...
[Claude] Removing flag from my-frontend/src/components/Dashboard.tsx...
...

--- RESULT ---
{
  "status": "success",
  "branchName": "remove-flag/enable-new-dashboard",
  "summary": "Removed enable-new-dashboard flag from 3 files",
  "filesChanged": ["my-frontend/src/components/Dashboard.tsx", "my-frontend/src/hooks/useFeatures.ts"],
  "repoResults": [
    { "repoName": "my-frontend", "status": "success", "prUrl": "https://github.com/org/my-frontend/pull/123" },
    { "repoName": "my-api", "status": "no-changes" }
  ]
}
```

## License

MIT
