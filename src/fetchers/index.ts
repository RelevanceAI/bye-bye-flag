/**
 * Fetcher Registry
 *
 * Central registry for all flag fetchers.
 * The orchestrator imports fetchers from here.
 */

import { fetchFlags as fetchPostHog } from './posthog/index.ts';
import type { FlagToRemove, FetcherConfig } from './types.ts';

export type { FlagToRemove, FetcherConfig, PostHogFetcherConfig } from './types.ts';

/**
 * Fetches flags using the configured fetcher
 */
export async function fetchFlags(config: FetcherConfig): Promise<FlagToRemove[]> {
  switch (config.type) {
    case 'posthog':
      return fetchPostHog(config);

    case 'manual':
      throw new Error('Manual fetcher requires --input flag. No fetcher to run.');
  }
}
