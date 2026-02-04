#!/usr/bin/env node
/**
 * PostHog Feature Flags Fetcher CLI
 *
 * Standalone CLI for fetching stale flags from PostHog.
 * Can be used for testing or piped to other tools.
 *
 * Usage:
 *   pnpm run fetch:posthog
 *   pnpm run fetch:posthog -- --stale-days=60
 *   pnpm run fetch:posthog -- --show-all
 */

import { fetchFlags, showAllFlags } from './index.ts';
import type { PostHogFetcherConfig } from '../types.ts';

function parseArgs(): { staleDays: number; showAll: boolean } {
  const args = process.argv.slice(2);
  let staleDays = 30;
  let showAll = false;

  for (const arg of args) {
    if (arg.startsWith('--stale-days=')) {
      staleDays = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--show-all') {
      showAll = true;
    }
  }

  return { staleDays, showAll };
}

async function main() {
  const { staleDays, showAll } = parseArgs();

  const config: PostHogFetcherConfig = {
    type: 'posthog',
    staleDays,
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
