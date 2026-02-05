/**
 * A flag that should be removed from the codebase
 */
export interface FlagToRemove {
  key: string;
  keepBranch: 'enabled' | 'disabled';
  reason?: string;
  lastModified?: string; // ISO date string for prioritization
  createdBy?: string; // Name or email of flag creator
  metadata?: Record<string, unknown>;
}

/**
 * Base fetcher configuration
 */
export interface BaseFetcherConfig {
  type: string;
}

/**
 * PostHog fetcher configuration
 */
export interface PostHogFetcherConfig extends BaseFetcherConfig {
  type: 'posthog';
  projectIds: string[];
  staleDays?: number;
  host?: string;
}

/**
 * Manual fetcher (requires --input flag)
 */
export interface ManualFetcherConfig extends BaseFetcherConfig {
  type: 'manual';
}

export type FetcherConfig = PostHogFetcherConfig | ManualFetcherConfig;

/**
 * Fetcher function signature
 */
export type FetcherFn<T extends BaseFetcherConfig = BaseFetcherConfig> = (
  config: T
) => Promise<FlagToRemove[]>;
