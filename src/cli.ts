#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { removeFlag } from './agent/index.ts';

const helpText = `
bye-bye-flag - Remove stale feature flags from codebases using AI

Usage:
  npx tsx src/cli.ts remove --flag=<key> --keep=<branch> --repos-dir=<path> [options]

Commands:
  remove    Remove a feature flag from one or more repositories

Options for 'remove':
  --flag=<key>           The feature flag key to remove (required)
  --keep=<branch>        Which branch to keep: "enabled" or "disabled" (required)
  --repos-dir=<path>     Path to directory containing bye-bye-flag.json and repo subdirectories (required)
  --dry-run              Show diff without creating PR
  --keep-worktree        Keep worktree after dry-run (for manual inspection with git diff)

Directory structure:
  repos-dir/
    bye-bye-flag.json    # Config file (required)
    CONTEXT.md           # Optional context for the AI
    repo1/               # Git repository
    repo2/               # Git repository (can have 1 or more repos)

Examples:
  # Remove a flag, keeping the enabled code path
  npx tsx src/cli.ts remove --flag=enable-dashboard --keep=enabled --repos-dir=/path/to/repos

  # Dry run to see what changes would be made
  npx tsx src/cli.ts remove --flag=enable-dashboard --keep=enabled --repos-dir=/path/to/repos --dry-run

  # Keep worktree for manual inspection
  npx tsx src/cli.ts remove --flag=enable-dashboard --keep=enabled --repos-dir=/path/to/repos --dry-run --keep-worktree
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      flag: { type: 'string' },
      keep: { type: 'string' },
      'repos-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'keep-worktree': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(helpText);
    process.exit(0);
  }

  const command = positionals[0];

  if (command === 'remove') {
    if (!values.flag || !values.keep) {
      console.error('Error: --flag and --keep are required for remove command');
      console.log(helpText);
      process.exit(1);
    }

    if (!values['repos-dir']) {
      console.error('Error: --repos-dir is required');
      console.log(helpText);
      process.exit(1);
    }

    if (values.keep !== 'enabled' && values.keep !== 'disabled') {
      console.error('Error: --keep must be "enabled" or "disabled"');
      process.exit(1);
    }

    const result = await removeFlag({
      flagKey: values.flag,
      keepBranch: values.keep,
      reposDir: values['repos-dir'],
      dryRun: values['dry-run'],
      keepWorktree: values['keep-worktree'],
    });

    console.log('\n--- RESULT ---');
    console.log(JSON.stringify(result, null, 2));

    process.exit(result.status === 'success' ? 0 : 1);
  } else {
    console.error(`Unknown command: ${command}`);
    console.log(helpText);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
