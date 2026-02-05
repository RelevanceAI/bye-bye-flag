#!/usr/bin/env node
/**
 * PostHog Feature Flags Fetcher CLI
 *
 * Standalone CLI for fetching stale flags from PostHog.
 * Can be used for testing or piped to other tools.
 *
 * Usage:
 *   pnpm run fetch:posthog -- --target-repos=/path/to/target-repos
 *   pnpm run fetch:posthog -- --target-repos=/path/to/target-repos --stale-days=60
 *   pnpm run fetch:posthog -- --target-repos=/path/to/target-repos --show-all
 */

import { parseArgs } from 'node:util';
import { fetchFlags, showAllFlags } from './index.ts';
import type { PostHogFetcherConfig } from '../types.ts';
import { loadEnvFileIfExists } from '../../env.ts';
import { loadConfigContext } from '../../config-context.ts';

function parseCliArgs(): { targetRepos?: string; staleDays?: number; showAll: boolean; help: boolean } {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const { values } = parseArgs({
    args,
    options: {
      'target-repos': { type: 'string' },
      'stale-days': { type: 'string' },
      'show-all': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  let staleDays: number | undefined = undefined;
  const staleDaysRaw = values['stale-days'];
  if (staleDaysRaw !== undefined) {
    const parsed = parseInt(staleDaysRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`--stale-days must be a positive integer, got "${staleDaysRaw}"`);
    }
    staleDays = parsed;
  }

  return {
    targetRepos: values['target-repos'],
    staleDays,
    showAll: values['show-all'],
    help: values.help ?? false,
  };
}

async function main() {
  loadEnvFileIfExists('.env');
  let targetRepos: string | undefined;
  let staleDays: number | undefined;
  let showAll: boolean;
  let help = false;
  try {
    ({ targetRepos, staleDays, showAll, help } = parseCliArgs());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (help || !targetRepos) {
    console.log(`
PostHog Feature Flags Fetcher

Usage:
  pnpm run fetch:posthog -- --target-repos=/path/to/target-repos [options]

Options:
  --target-repos=<path> Path to target repos root (required)
  --stale-days=<days>   Override stale days from config
  --show-all            Print all flags before stale filtering
  -h, --help            Show this help
`);
    process.exit(help ? 0 : 1);
  }

  const byeByeConfig = (await loadConfigContext(targetRepos)).config;
  const fetcher = byeByeConfig.fetcher;
  if (!fetcher || fetcher.type !== 'posthog') {
    console.error('Error: fetcher.type must be "posthog" in bye-bye-flag-config.json');
    process.exit(1);
  }

  const config: PostHogFetcherConfig = {
    ...fetcher,
    staleDays: staleDays ?? fetcher.staleDays,
  };

  if (showAll) {
    await showAllFlags(config);
  }

  const flags = await fetchFlags(config);

  // Output JSON to stdout (for piping to other tools)
  console.log(JSON.stringify(flags, null, 2));
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
