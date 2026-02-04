/**
 * Fetcher Registry
 *
 * Central registry for all flag fetchers.
 * The orchestrator imports fetchers from here.
 */

import { fetchFlags as fetchPostHog } from './posthog/index.ts';
import type { FlagToRemove, FetcherConfig, PostHogFetcherConfig } from './types.ts';

export type { FlagToRemove, FetcherConfig, PostHogFetcherConfig } from './types.ts';

/**
 * Fetches flags using the configured fetcher
 */
export async function fetchFlags(config: FetcherConfig): Promise<FlagToRemove[]> {
  switch (config.type) {
    case 'posthog':
      return fetchPostHog(config as PostHogFetcherConfig);

    case 'manual':
      throw new Error('Manual fetcher requires --input flag. No fetcher to run.');

    default:
      throw new Error(`Unknown fetcher type: ${(config as FetcherConfig).type}`);
  }
}

/**
 * Available fetcher types
 */
export const FETCHER_TYPES = ['posthog', 'manual'] as const;
export type FetcherType = (typeof FETCHER_TYPES)[number];
