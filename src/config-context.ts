import * as path from 'path';
import { CONFIG_FILENAME, readConfig, type ByeByeFlagConfig } from './agent/scaffold.ts';
import type { FetcherConfig } from './fetchers/types.ts';

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_PRS = 10;
const DEFAULT_LOG_DIR = './bye-bye-flag-logs';
export const DEFAULT_CONFIG_FILENAME = CONFIG_FILENAME;

export interface ConfigContext {
  reposDir: string;
  configPath: string;
  config: ByeByeFlagConfig;
}

export interface RuntimeSettings {
  concurrency: number;
  maxPrs: number;
  logDir: string;
}

export function resolveConfigLocation(targetReposDir: string): { reposDir: string; configPath: string } {
  const resolvedReposDir = path.resolve(targetReposDir);
  return {
    reposDir: resolvedReposDir,
    configPath: path.join(resolvedReposDir, DEFAULT_CONFIG_FILENAME),
  };
}

export async function loadConfigContext(targetReposDir: string): Promise<ConfigContext> {
  const location = resolveConfigLocation(targetReposDir);
  const config = await readConfig(location.reposDir, location.configPath);
  return { ...location, config };
}

export function getRuntimeSettings(config: ByeByeFlagConfig): RuntimeSettings {
  return {
    concurrency: config.orchestrator?.concurrency ?? DEFAULT_CONCURRENCY,
    maxPrs: config.orchestrator?.maxPrs ?? DEFAULT_MAX_PRS,
    logDir: config.orchestrator?.logDir ?? DEFAULT_LOG_DIR,
  };
}

export function requireFetcher(config: ByeByeFlagConfig): FetcherConfig {
  if (!config.fetcher) {
    throw new Error(
      'Missing "fetcher" config in bye-bye-flag-config.json. Add fetcher.type and (for PostHog) fetcher.projectIds, or use --input.'
    );
  }
  return config.fetcher;
}
