#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { removeFlag } from './agent/index.ts';
import { run, runWithInput } from './orchestrator/index.ts';
import { setupSignalHandlers } from './process-tracker.ts';
import { loadEnvFileIfExists } from './env.ts';
import { loadConfigContext, requireFetcher } from './config-context.ts';

const helpText = `
bye-bye-flag - Remove stale feature flags from codebases using AI

Usage:
  bye-bye-flag <command> [options]

  # From source (after pnpm install)
  pnpm start <command> [options]

Commands:
  run       Fetch stale flags and process them (main command)
  remove    Remove a single flag (for testing/manual use)

Options for 'run':
  --target-repos=<path>  Path to target repos root (required)
  --input=<file>         Use a JSON file instead of fetcher (optional)
  --dry-run              Run agents in dry-run mode (no PRs)

Options for 'remove':
  --flag=<key>           The feature flag key to remove (required)
  --keep=<branch>        Which branch to keep: "enabled" or "disabled" (required)
  --target-repos=<path>  Path to target repos root (required)
  --dry-run              Show diff without creating PR
  --keep-worktree        Keep worktree after completion

Configuration (bye-bye-flag-config.json):
  {
    "fetcher": {
      "type": "posthog",
      "projectIds": [12345],
      "staleDays": 30
    },
    "agent": {
      "type": "claude"
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
      "setup": ["pnpm install"]
    },
    "repos": {
      "my-repo": {}
    }
  }

Examples:
  # Run the orchestrator (fetches stale flags and processes them)
  bye-bye-flag run --target-repos=/path/to/target-repos

  # Dry run to see what would happen
  bye-bye-flag run --target-repos=/path/to/target-repos --dry-run

  # Process a custom list of flags
  bye-bye-flag run --target-repos=/path/to/target-repos --input=my-flags.json

  # Remove a single flag manually
  bye-bye-flag remove --target-repos=/path/to/target-repos --flag=my-flag --keep=enabled
`;

async function main() {
  loadEnvFileIfExists('.env');
  setupSignalHandlers();
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      // Shared
      'target-repos': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },

      // run command
      input: { type: 'string' },

      // remove command
      flag: { type: 'string' },
      keep: { type: 'string' },
      'keep-worktree': { type: 'boolean', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(helpText);
    process.exit(0);
  }

  const command = positionals[0];
  const targetReposArg = values['target-repos'];

  if (!targetReposArg) {
    console.error('Error: --target-repos is required');
    console.log(helpText);
    process.exit(1);
  }

  if (command === 'run') {
    let configContext: Awaited<ReturnType<typeof loadConfigContext>>;
    try {
      configContext = await loadConfigContext(targetReposArg);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      console.log(helpText);
      process.exit(1);
    }

    // If --input is provided, use file instead of fetcher
    if (values.input) {
      const summary = await runWithInput({
        configContext,
        inputFile: values.input,
        dryRun: values['dry-run'],
      });
      process.exit(summary.results.failed > 0 ? 1 : 0);
    }

    const fetcher = requireFetcher(configContext.config);
    if (fetcher.type === 'manual') {
      console.error('Error: Fetcher type is "manual" but no --input file provided');
      process.exit(1);
    }

    const summary = await run({
      configContext,
      fetcher,
      dryRun: values['dry-run'],
    });

    process.exit(summary.results.failed > 0 ? 1 : 0);
  } else if (command === 'remove') {
    if (!values.flag || !values.keep) {
      console.error('Error: --flag and --keep are required for remove command');
      console.log(helpText);
      process.exit(1);
    }

    if (values.keep !== 'enabled' && values.keep !== 'disabled') {
      console.error('Error: --keep must be "enabled" or "disabled"');
      process.exit(1);
    }

    let configContext: Awaited<ReturnType<typeof loadConfigContext>>;
    try {
      configContext = await loadConfigContext(targetReposArg);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      console.log(helpText);
      process.exit(1);
    }

    const result = await removeFlag({
      flagKey: values.flag,
      keepBranch: values.keep,
      configContext,
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
