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
git clone https://github.com/your-org/bye-bye-flag.git
cd bye-bye-flag
nvm use
pnpm install
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

```bash
# Custom worktree location (default: /tmp/bye-bye-flag-worktrees)
WORKTREE_BASE_PATH=/path/to/worktrees
```

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
