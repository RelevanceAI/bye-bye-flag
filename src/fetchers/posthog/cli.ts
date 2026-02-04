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
import { loadEnvFileIfExists } from '../../env.ts';

function parseArgs(): { staleDays: number; showAll: boolean } {
  const args = process.argv.slice(2);
  let staleDays = 30;
  let showAll = false;

  for (const arg of args) {
    if (arg.startsWith('--stale-days=')) {
      const value = arg.split('=')[1] ?? '';
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`--stale-days must be a positive integer, got "${value}"`);
      }
      staleDays = parsed;
    } else if (arg === '--show-all') {
      showAll = true;
    }
  }

  return { staleDays, showAll };
}

async function main() {
  loadEnvFileIfExists('.env');
  let staleDays: number;
  let showAll: boolean;
  try {
    ({ staleDays, showAll } = parseArgs());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

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
