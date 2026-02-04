#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { removeFlag } from './agent/index.ts';
import { run, runWithInput } from './orchestrator/index.ts';
import { readConfig } from './agent/scaffold.ts';
import { setupSignalHandlers } from './process-tracker.ts';
import type { FetcherConfig } from './fetchers/types.ts';
import { loadEnvFileIfExists } from './env.ts';

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
  --repos-dir=<path>     Path to directory containing bye-bye-flag-config.json (required)
  --concurrency=<n>      Max agents running in parallel (default: 2)
  --max-prs=<n>          Stop after creating this many PRs (default: 10)
  --log-dir=<path>       Directory for agent logs (default: ./bye-bye-flag-logs)
  --input=<file>         Use a JSON file instead of fetcher (optional)
  --dry-run              Run agents in dry-run mode (no PRs)

Options for 'remove':
  --flag=<key>           The feature flag key to remove (required)
  --keep=<branch>        Which branch to keep: "enabled" or "disabled" (required)
  --repos-dir=<path>     Path to directory containing bye-bye-flag-config.json (required)
  --dry-run              Show diff without creating PR
  --keep-worktree        Keep worktree after completion

Configuration (bye-bye-flag-config.json):
  {
    "fetcher": {
      "type": "posthog",
      "staleDays": 30
    },
    "agent": {
      "type": "claude"
    },
    "orchestrator": {
      "concurrency": 2,
      "maxPrs": 10
    },
    "repos": {
      "my-repo": { "setup": ["pnpm install"] }
    }
  }

Examples:
  # Run the orchestrator (fetches stale flags and processes them)
  bye-bye-flag run --repos-dir=/path/to/repos

  # Dry run to see what would happen
  bye-bye-flag run --repos-dir=/path/to/repos --dry-run

  # Process a custom list of flags
  bye-bye-flag run --repos-dir=/path/to/repos --input=my-flags.json

  # Remove a single flag manually
  bye-bye-flag remove --flag=my-flag --keep=enabled --repos-dir=/path/to/repos
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
      'repos-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },

      // run command
      concurrency: { type: 'string' },
      'max-prs': { type: 'string' },
      'log-dir': { type: 'string' },
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

  if (command === 'run') {
    if (!values['repos-dir']) {
      console.error('Error: --repos-dir is required');
      console.log(helpText);
      process.exit(1);
    }

    const reposDir = values['repos-dir'];

    // Read config to get fetcher and orchestrator settings
    let config: Awaited<ReturnType<typeof readConfig>>;
    try {
      config = await readConfig(reposDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }

    // Helper to parse and validate numeric CLI arguments
    const parsePositiveInt = (
      value: string | undefined,
      name: string,
      defaultValue?: number
    ): number | undefined => {
      if (value === undefined) return defaultValue;
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
        console.error(`Error: --${name} must be a positive integer, got "${value}"`);
        process.exit(1);
      }
      return parsed;
    };

    const parseNonNegativeInt = (
      value: string | undefined,
      name: string,
      defaultValue?: number
    ): number | undefined => {
      if (value === undefined) return defaultValue;
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        console.error(`Error: --${name} must be a non-negative integer, got "${value}"`);
        process.exit(1);
      }
      return parsed;
    };

    // Merge CLI options with config file
    const concurrency =
      parsePositiveInt(values.concurrency, 'concurrency', config.orchestrator?.concurrency) ?? 2;
    const maxPrs =
      parseNonNegativeInt(values['max-prs'], 'max-prs', config.orchestrator?.maxPrs) ?? 10;
    const logDir = values['log-dir'] || config.orchestrator?.logDir;

    // If --input is provided, use file instead of fetcher
    if (values.input) {
      const summary = await runWithInput({
        reposDir,
        inputFile: values.input,
        concurrency,
        maxPrs,
        logDir,
        dryRun: values['dry-run'],
      });
      process.exit(summary.results.failed > 0 ? 1 : 0);
    }

    // Get fetcher config (default to posthog)
    const fetcher: FetcherConfig = config.fetcher || { type: 'posthog' };

    if (fetcher.type === 'manual') {
      console.error('Error: Fetcher type is "manual" but no --input file provided');
      process.exit(1);
    }

    const summary = await run({
      reposDir,
      fetcher,
      concurrency,
      maxPrs,
      logDir,
      dryRun: values['dry-run'],
    });

    process.exit(summary.results.failed > 0 ? 1 : 0);
  } else if (command === 'remove') {
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
