# bye-bye-flag

Remove stale feature flags from codebases using AI.

`bye-bye-flag` uses a CLI coding agent to automatically find and remove feature flag conditionals, clean up dead code, and create pull requests.

## Prerequisites

- **Node.js 24+** (native TypeScript support)
- **git**
- **Agent CLI**: at least one coding-agent CLI in your `PATH`
  - Built-in adapters: **[Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code)** (`claude`) and **[Codex CLI](https://developers.openai.com/codex/cli/)** (`codex`)
  - Generic adapter: any CLI command configured via `agent.type`/`agent.command`
  - macOS: if you installed the **[Codex app](https://openai.com/codex/)**, the CLI binary is bundled at `/Applications/Codex.app/Contents/Resources/codex`. To expose it on your `PATH`:
    ```bash
    ln -s /Applications/Codex.app/Contents/Resources/codex ~/.local/bin/codex
    ```
- **[GitHub CLI](https://cli.github.com/)**: Required for creating PRs (not needed for `--dry-run`)

## Installation

```bash
git clone https://github.com/RelevanceAI/bye-bye-flag.git
cd bye-bye-flag
nvm use
pnpm install

# Create .env file with secrets (optional if using --input)
cp .env.example .env
# Edit .env with your PostHog API key (POSTHOG_API_KEY)
```

## Directory Structure

Set up your repos directory with the following structure:

```
my-repos/
  bye-bye-flag-config.json    # Config file (required)
  CONTEXT.md           # Optional context for the AI
  repo1/               # Git repository
  repo2/               # Git repository (can have 1 or more repos)
```

## Usage

If you're running from source, replace `bye-bye-flag` with `pnpm start`.
Pass `--target-repos` to point at the directory that contains `bye-bye-flag-config.json` and all target repos.

```bash
# Run the orchestrator - fetches stale flags and processes them
bye-bye-flag run --target-repos=/path/to/target-repos

# Dry run to preview what would happen
bye-bye-flag run --target-repos=/path/to/target-repos --dry-run

# Find flags with no code references (quick wins to delete from PostHog)
# Set "orchestrator.maxPrs": 0 in config, then run:
bye-bye-flag run --target-repos=/path/to/target-repos

# Process flags from a custom JSON file
bye-bye-flag run --target-repos=/path/to/target-repos --input=my-flags.json

# Remove a single flag manually (for testing)
bye-bye-flag remove --target-repos=/path/to/target-repos --flag=enable-dashboard --keep=enabled
```

## Options

### `run` command (main command)

| Option | Default | Description |
|--------|---------|-------------|
| `--target-repos=<path>` | (required) | Path to target repos root |
| `--input=<file>` | (fetcher) | Use a JSON file instead of fetcher |
| `--dry-run` | false | Run agents in dry-run mode (no PRs) |

### `remove` command (single flag)

| Option | Description |
|--------|-------------|
| `--flag=<key>` | The feature flag key to remove (required) |
| `--keep=<branch>` | Which code path to keep: `enabled` or `disabled` (required) |
| `--target-repos=<path>` | Path to target repos root (required) |
| `--dry-run` | Preview changes without creating a PR |
| `--keep-worktree` | Keep the worktree after completion for manual inspection |

### `test-setup` command (debug setup issues)

Test your `bye-bye-flag-config.json` setup commands without running the full orchestrator:

```bash
# Test all repos
pnpm test-setup --target-repos=/path/to/target-repos

# Test a specific repo
pnpm test-setup --target-repos=/path/to/target-repos --repo=my-api

# Test only worktree setup (skip mainSetup)
pnpm test-setup --target-repos=/path/to/target-repos --skip-main-setup

# Test only mainSetup (skip worktree creation)
pnpm test-setup --target-repos=/path/to/target-repos --skip-worktree
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
- **Worktrees are preserved**: After creating a PR, the worktree is kept for resuming the agent session. Worktrees are automatically cleaned up when their PR is merged or closed.

### Resuming a Session

If you need to make changes or continue working on a PR, the PR description includes a resume command matching the configured agent:

```bash
# Claude Code
cd /tmp/bye-bye-flag-worktrees/remove-flag-my-flag && claude --resume <session-id>

# Codex CLI
cd /tmp/bye-bye-flag-worktrees/remove-flag-my-flag && codex resume <session-id>
```

This lets you continue the agent session with full context of what was already done.

## Configuration

Create a `bye-bye-flag-config.json` in your repos directory:

Example files are available in `examples/`.

```json
{
  "fetcher": {
    "type": "posthog",
    "projectIds": [12345, 67890],
    "staleDays": 30
  },
  "worktrees": {
    "basePath": "/tmp/bye-bye-flag-worktrees"
  },
  "orchestrator": {
    "concurrency": 3,
    "maxPrs": 10,
    "logDir": "./bye-bye-flag-logs"
  },
  "repoDefaults": {
    "shellInit": "source ~/.nvm/nvm.sh && nvm use",
    "baseBranch": "main"
  },
  "repos": {
    "my-api": {
      "baseBranch": "development",
      "setup": ["pnpm install", "pnpm run codegen"]
    },
    "my-frontend": {
      "shellInit": "source ~/.asdf/asdf.sh",
      "baseBranch": "main",
      "setup": ["pnpm install"]
    }
  }
}
```

### Agent Configuration

- `agent.type`: Agent identifier. Built-in values are `claude` and `codex` (default: `claude`)
- `agent.args`: Extra CLI args appended to the agent invocation (optional)
- `agent.timeoutMinutes`: Timeout for a single agent run, in minutes (default: 60)
- `agent.command` (generic agents): CLI command to execute (defaults to `agent.type`)
- `agent.promptMode` (generic agents): `stdin` (default) or `arg`
- `agent.promptArg` (generic agents): prompt flag when `promptMode` is `arg` (default: `-p`)
- `agent.versionArgs` (generic agents): args used for prerequisite check (default: `["--version"]`)
- `agent.sessionIdRegex` (generic agents): regex to extract session IDs from output
- `agent.resume` (generic agents): resume command templates used in PR metadata
- Parse failures automatically trigger a second call to the same configured agent to normalize output into the expected JSON shape

Built-in agent example:

```json
{
  "agent": {
    "type": "codex",
    "args": ["--model", "o3"],
    "timeoutMinutes": 60
  }
}
```

Generic agent example:
```json
{
  "agent": {
    "type": "opencode",
    "command": "opencode",
    "args": ["run"],
    "promptMode": "stdin",
    "resume": {
      "withSessionId": "cd {{workspacePath}} && {{command}} resume {{sessionId}}",
      "withoutSessionId": "cd {{workspacePath}} && {{command}} resume"
    }
  }
}
```

### Fetcher Configuration

- `fetcher.type`: Which fetcher to use (`posthog` or `manual`)
- `fetcher.projectIds`: PostHog project IDs to fetch flags from (required for `posthog`)
- `fetcher.staleDays`: Days since last update to consider a flag stale (default: 30)
- `fetcher.host`: PostHog host (optional, default: `https://app.posthog.com`)

### Orchestrator Configuration

- `orchestrator.concurrency`: Max agents running in parallel (default: 3)
- `orchestrator.maxPrs`: Stop after creating this many PRs (default: 10)
- `orchestrator.logDir`: Directory for agent logs (default: `./bye-bye-flag-logs`)

### Worktree Configuration

- `worktrees.basePath`: Where to create worktrees (optional, default: `/tmp/bye-bye-flag-worktrees`)

### Repo Configuration

- `repoDefaults.shellInit` (optional): Default command to run before each shell command (setup and agent)
- `repoDefaults.baseBranch` (optional): Shared base branch for worktree creation and code search
- `repoDefaults.mainSetup` (optional): Default mainSetup commands (applied to every repo unless overridden)
- `repoDefaults.setup`: Default setup commands for worktrees (recommended)
- `repos.<name>.shellInit` (optional): Override shellInit for a specific repo
- `repos.<name>.baseBranch` (optional): Override base branch for a specific repo (for example `development`)
- `baseBranch` is required for every repo via either `repoDefaults.baseBranch` or `repos.<name>.baseBranch` (no implicit fallback)
- `repos.<name>.mainSetup` (optional): Override mainSetup commands for a repo
- `repos.<name>.setup` (optional): Override setup commands for a repo (supports `${MAIN_REPO}` substitution)

**Simple setup:** Install dependencies in each worktree (most compatible, slower):

```json
{
  "repoDefaults": {
    "baseBranch": "main",
    "setup": ["pnpm install"]
  },
  "repos": {
    "my-repo": {}
  }
}
```

**Optimization tip:** Use `mainSetup` to run `pnpm install` once on the main repo (to populate the pnpm store), then use `setup` to prefer cached packages in each worktree:

```json
{
  "repos": {
    "my-repo": {
      "mainSetup": ["pnpm install"],
      "setup": ["pnpm install --frozen-lockfile --prefer-offline"]
    }
  }
}
```

This avoids network downloads for every flag while keeping the worktree `node_modules` layout consistent.

If you need to guarantee **no network access**, use `--offline` instead. Note: `--offline` will fail if the required packages are not already present in the pnpm store.

If you've verified that copying/linking `node_modules` works for your repo, you can do that instead (faster, but less portable):

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

## Context Files

You can provide additional context to the agent by placing markdown files in your repos directory:

- `CLAUDE.md` - Agent instructions (coding standards, patterns to follow)
- `CONTEXT.md` - General context about how the repositories relate

These files are automatically included in the prompt.

## Environment Variables (Secrets)

Create a `.env` file (copy from `.env.example`) if you're using the PostHog fetcher:

```bash
# PostHog integration (required for fetching stale flags)
POSTHOG_API_KEY=phx_xxx
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
pnpm run fetch:posthog -- --target-repos=/path/to/target-repos

# Custom stale threshold (days)
pnpm run fetch:posthog -- --target-repos=/path/to/target-repos --stale-days=60

# Show all flags with their status (not just stale ones)
pnpm run fetch:posthog -- --target-repos=/path/to/target-repos --show-all
```

Output is JSON to stdout:
```json
[
  {
    "key": "old-feature",
    "keepBranch": "enabled",
    "reason": "100% rollout for 45 days",
    "lastModified": "2025-12-01T00:00:00.000Z",
    "metadata": {
      "projects": ["12345", "67890"]
    }
  },
  {
    "key": "killed-feature",
    "keepBranch": "disabled",
    "reason": "Inactive for 90 days",
    "lastModified": "2025-11-01T00:00:00.000Z",
    "metadata": {
      "projects": ["12345"]
    }
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
  ○ 0 no changes needed
  ○ 3 no code references
  ✗ 0 failed
  ⊘ 1 skipped
  … 11 remaining (maxPrs limit)

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
