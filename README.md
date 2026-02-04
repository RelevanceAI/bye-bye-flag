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
# Run the orchestrator - fetches stale flags and processes them
pnpm start run --repos-dir=/path/to/my-repos

# Dry run to preview what would happen
pnpm start run --repos-dir=/path/to/my-repos --dry-run

# Find flags with no code references (quick wins to delete from PostHog)
pnpm start run --repos-dir=/path/to/my-repos --max-prs=0

# Process flags from a custom JSON file
pnpm start run --repos-dir=/path/to/my-repos --input=my-flags.json

# Remove a single flag manually (for testing)
pnpm start remove --flag=enable-dashboard --keep=enabled --repos-dir=/path/to/my-repos
```

## Options

### `run` command (main command)

| Option | Default | Description |
|--------|---------|-------------|
| `--repos-dir=<path>` | (required) | Path to directory containing bye-bye-flag.json |
| `--concurrency=<n>` | 2 | Max agents running in parallel |
| `--max-prs=<n>` | 10 | Stop after creating this many PRs |
| `--log-dir=<path>` | `./bye-bye-flag-logs` | Directory for agent logs |
| `--input=<file>` | (fetcher) | Use a JSON file instead of fetcher |
| `--dry-run` | false | Run agents in dry-run mode (no PRs) |

### `remove` command (single flag)

| Option | Description |
|--------|-------------|
| `--flag=<key>` | The feature flag key to remove (required) |
| `--keep=<branch>` | Which code path to keep: `enabled` or `disabled` (required) |
| `--repos-dir=<path>` | Path to directory containing bye-bye-flag.json (required) |
| `--dry-run` | Preview changes without creating a PR |
| `--keep-worktree` | Keep the worktree after completion for manual inspection |

### `test-setup` command (debug setup issues)

Test your `bye-bye-flag.json` setup commands without running the full orchestrator:

```bash
# Test all repos
pnpm test-setup --repos-dir=/path/to/my-repos

# Test a specific repo
pnpm test-setup --repos-dir=/path/to/my-repos --repo=my-api

# Test only worktree setup (skip mainSetup)
pnpm test-setup --repos-dir=/path/to/my-repos --skip-main-setup

# Test only mainSetup (skip worktree creation)
pnpm test-setup --repos-dir=/path/to/my-repos --skip-worktree
```

This creates a temporary worktree, runs your setup commands, and cleans up. Useful for debugging setup failures.

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
  "fetcher": {
    "type": "posthog",
    "staleDays": 30
  },
  "orchestrator": {
    "concurrency": 2,
    "maxPrs": 10
  },
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

### Fetcher Configuration

- `fetcher.type`: Which fetcher to use (`posthog` or `manual`)
- `fetcher.staleDays`: Days since last update to consider a flag stale (default: 30)

### Orchestrator Configuration

- `orchestrator.concurrency`: Max agents running in parallel (default: 2)
- `orchestrator.maxPrs`: Stop after creating this many PRs (default: 10)
- `orchestrator.logDir`: Directory for agent logs (default: `./bye-bye-flag-logs`)

### Repo Configuration

- `shellInit` (optional): Default command to run before each shell command (setup and Claude)
- `repos.<name>.shellInit` (optional): Override shellInit for a specific repo
- `repos.<name>.mainSetup` (optional): Setup commands for the main repo (run once per orchestrator run)
- `repos.<name>.setup`: Setup commands for worktrees (run per flag, supports `${MAIN_REPO}` substitution)

**Optimization tip:** Use `mainSetup` to run `pnpm install` once on the main repo, then use `setup` to copy/link node_modules to worktrees:

```json
{
  "repos": {
    "my-repo": {
      "mainSetup": ["pnpm install"],
      "setup": ["cp -al ${MAIN_REPO}/node_modules ./node_modules"]
    }
  }
}
```

This avoids running `pnpm install` for every flag, significantly speeding up batch processing.

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
════════════════════════════════════════════════════════════
                    bye-bye-flag Orchestrator
════════════════════════════════════════════════════════════
Repos directory: ./my-repos
Concurrency: 2
Max PRs: 10
Dry run: false
════════════════════════════════════════════════════════════

Logs: ./bye-bye-flag-logs/2024-01-15T10-30-00

Fetching latest from origin...
  Fetching my-api...
  Fetching my-frontend...

Running main setup on repos...
  my-api:
    Running: pnpm install

Fetching stale flags...
Fetched 25 stale flags

Checking for existing PRs...
  Fetching PRs from my-api...
    Found 3 bye-bye-flag PRs
  Fetching PRs from my-frontend...
    Found 2 bye-bye-flag PRs
  ⊘ old-feature: Open PR exists (skipping)
  15 flags passed PR check (1 skipped)

Checking for code references...
  ○ unused-flag: No code references
  12 flags have code references (3 have no code)

Processing up to 10 PRs with concurrency 2...

▶ Starting: enable-dashboard (0/10 PRs)
    Keep: enabled | Worktree: /tmp/bye-bye-flag-worktrees/remove-flag-enable-dashboard
▶ Starting: new-feature (0/10 PRs)
    Keep: enabled | Worktree: /tmp/bye-bye-flag-worktrees/remove-flag-new-feature
✓ Complete: enable-dashboard (1 PR(s), 1/10 total, 2m 15s)
✓ Complete: new-feature (2 PR(s), 3/10 total, 3m 42s)
...

════════════════════════════════════════════════════════════
                    bye-bye-flag Run Complete
════════════════════════════════════════════════════════════
Fetcher: posthog (found 25 stale flags)
Duration: 15m 30s
Processed: 10 flags

  ✓ 10 PRs created
  ○ 3 no code references
  ✗ 0 failed
  ⊘ 1 skipped
  … 11 remaining (--max-prs limit)

PRs created:
  • enable-dashboard: https://github.com/org/my-frontend/pull/123
  • new-feature: https://github.com/org/my-api/pull/456
  • new-feature: https://github.com/org/my-frontend/pull/457
  ...

Skipped:
  • old-feature: Open PR: https://github.com/org/my-frontend/pull/100

Logs: ./bye-bye-flag-logs/2024-01-15T10-30-00

To continue processing remaining flags, run the command again.
```

## License

MIT
