/**
 * PostHog Feature Flags Fetcher
 *
 * Fetches stale feature flags from PostHog that are candidates for removal.
 *
 * Criteria for stale flags:
 * - updated_at > staleDays ago (default: 30)
 * - Either 0% or 100% rollout (no complex targeting)
 * - No payload
 * - No multivariate variants
 * - If flag exists in multiple projects, must be consistent across all
 */

import type { FlagToRemove, PostHogFetcherConfig } from '../types.ts';

// PostHog API types
interface PostHogUser {
  id: number;
  email: string;
  first_name?: string;
  last_name?: string;
}

interface PostHogFlag {
  id: number;
  key: string;
  name: string;
  active: boolean;
  deleted: boolean;
  created_at: string;
  updated_at: string;
  created_by: PostHogUser | null;
  status: string;
  filters: {
    groups?: Array<{
      properties?: unknown[];
      rollout_percentage?: number;
    }>;
    multivariate?: {
      variants?: unknown[];
    };
    payloads?: Record<string, unknown>;
  };
}

interface PostHogResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: PostHogFlag[];
}

interface FlagInfo {
  key: string;
  projectId: string;
  updatedAt: Date;
  rolloutPercentage: number | null;
  hasPayload: boolean;
  hasVariants: boolean;
  active: boolean;
  deleted: boolean;
  createdBy: string | null;
}

// Default: 30 days
const DEFAULT_STALE_DAYS = 30;

/**
 * Fetches stale flags from PostHog
 */
export async function fetchFlags(config: PostHogFetcherConfig): Promise<FlagToRemove[]> {
  const apiKey = process.env.POSTHOG_API_KEY;
  const projectIds = config.projectIds;
  const host = config.host || 'https://app.posthog.com';
  const staleDays = config.staleDays ?? DEFAULT_STALE_DAYS;

  if (!apiKey) {
    throw new Error('Missing POSTHOG_API_KEY environment variable');
  }

  if (projectIds.length === 0) {
    throw new Error('Missing fetcher.projectIds in bye-bye-flag-config.json');
  }

  console.error(`Fetching feature flags from PostHog...`);
  console.error(`Projects: ${projectIds.join(', ')}`);

  // Fetch flags from all projects
  const flagsByProject = new Map<string, PostHogFlag[]>();
  let totalFlags = 0;

  const fetched = await Promise.all(
    projectIds.map(async (projectId) => {
      console.error(`  Fetching project ${projectId}...`);
      const flags = await fetchFlagsForProject(projectId, apiKey, host);
      console.error(`    Found ${flags.length} flags`);
      return { projectId, flags };
    })
  );

  for (const { projectId, flags } of fetched) {
    flagsByProject.set(projectId, flags);
    totalFlags += flags.length;
  }

  console.error(`Total: ${totalFlags} flags across ${projectIds.length} project(s)`);

  const staleFlags = analyzeFlagsAcrossProjects(flagsByProject, staleDays);
  console.error(
    `\nFound ${staleFlags.length} stale flags (>${staleDays} days, 0% or 100% rollout, no payload, consistent across projects)`
  );

  return staleFlags;
}

async function fetchFlagsForProject(
  projectId: string,
  apiKey: string,
  host: string
): Promise<PostHogFlag[]> {
  const allFlags: PostHogFlag[] = [];
  let url: string | null = `${host}/api/projects/${projectId}/feature_flags/`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `PostHog API error for project ${projectId}: ${response.status} ${response.statusText}\n${text}`
      );
    }

    const data: PostHogResponse = await response.json();
    allFlags.push(...data.results);
    url = data.next;
  }

  return allFlags;
}

function getRolloutPercentage(flag: PostHogFlag): number | null {
  const groups = flag.filters?.groups;

  // No groups - check active status
  if (!groups || groups.length === 0) {
    return flag.active ? 100 : 0;
  }

  // If there's exactly one group with a rollout percentage and no properties (targeting)
  if (groups.length === 1) {
    const group = groups[0];
    const hasTargeting = group.properties && group.properties.length > 0;
    if (!hasTargeting && group.rollout_percentage !== undefined) {
      return group.rollout_percentage;
    }
  }

  // Complex targeting rules - not a simple 0% or 100%
  return null;
}

function hasPayload(flag: PostHogFlag): boolean {
  const payloads = flag.filters?.payloads;
  if (!payloads) return false;

  // Check if any payload values are non-null/non-empty
  return Object.values(payloads).some((v) => v !== null && v !== undefined && v !== '');
}

function hasVariants(flag: PostHogFlag): boolean {
  const variants = flag.filters?.multivariate?.variants;
  return Boolean(variants && variants.length > 0);
}

function extractCreatorIdentifier(user: PostHogUser | null): string | null {
  if (!user) return null;
  if (user.email) {
    const localPart = user.email.split('@')[0];
    return localPart || user.email;
  }
  if (user.first_name || user.last_name) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ');
  }
  return null;
}

function analyzeFlagsAcrossProjects(
  flagsByProject: Map<string, PostHogFlag[]>,
  staleDays: number
): FlagToRemove[] {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);

  // Group flags by key across all projects
  const flagsByKey = new Map<string, FlagInfo[]>();

  for (const [projectId, flags] of flagsByProject) {
    for (const flag of flags) {
      const createdBy = extractCreatorIdentifier(flag.created_by);

      const info: FlagInfo = {
        key: flag.key,
        projectId,
        updatedAt: new Date(flag.updated_at),
        rolloutPercentage: getRolloutPercentage(flag),
        hasPayload: hasPayload(flag),
        hasVariants: hasVariants(flag),
        active: flag.active,
        deleted: flag.deleted,
        createdBy,
      };

      const existing = flagsByKey.get(flag.key) || [];
      existing.push(info);
      flagsByKey.set(flag.key, existing);
    }
  }

  // Find flags that are stale in ALL projects where they exist
  const staleFlags: FlagToRemove[] = [];

  for (const [key, infos] of flagsByKey) {
    // Check if ALL instances meet the stale criteria
    const allStale = infos.every((info) => {
      // Skip deleted flags
      if (info.deleted) return false;

      // Inactive flags are always candidates (keep disabled branch)
      if (!info.active) return info.updatedAt <= staleThreshold;

      // Active flags: must have simple rollout (0% or 100%)
      if (info.rolloutPercentage !== 0 && info.rolloutPercentage !== 100) return false;

      // Must not have payload or variants
      if (info.hasPayload || info.hasVariants) return false;

      // Must be older than threshold
      if (info.updatedAt > staleThreshold) return false;

      return true;
    });

    if (!allStale || infos.length === 0) continue;

    // Determine keepBranch:
    // - Inactive flags → disabled
    // - Active at 0% → disabled
    // - Active at 100% → enabled
    // Check consistency across projects
    const keepBranches = infos.map((info) => {
      if (!info.active) return 'disabled';
      return info.rolloutPercentage === 100 ? 'enabled' : 'disabled';
    });
    const uniqueKeepBranches = new Set(keepBranches);

    // All instances must agree on which branch to keep
    if (uniqueKeepBranches.size !== 1) continue;

    const keepBranch = keepBranches[0] as 'enabled' | 'disabled';
    // Use the most recent modification date across all projects
    const latestDate = new Date(Math.max(...infos.map((i) => i.updatedAt.getTime())));
    const daysSinceModified = Math.floor((now.getTime() - latestDate.getTime()) / (24 * 60 * 60 * 1000));

    // Build reason
    const isInactive = infos.some((i) => !i.active);
    const rollout = infos[0].rolloutPercentage;
    const reason = isInactive
      ? `Inactive for ${daysSinceModified} days`
      : `${rollout}% rollout for ${daysSinceModified} days`;

    // Include all distinct creators when flags differ across projects/environments.
    const creators = [...new Set(infos.map((i) => i.createdBy).filter((creator): creator is string => Boolean(creator)))];
    const createdBy = creators.length > 0 ? creators.join(', ') : undefined;

    staleFlags.push({
      key,
      keepBranch,
      reason,
      lastModified: latestDate.toISOString(),
      createdBy,
      metadata: {
        rolloutPercentage: rollout ?? 0,
        projects: infos.map((i) => i.projectId),
      },
    });
  }

  // Sort by oldest first (prioritize removing older flags)
  staleFlags.sort(
    (a, b) => new Date(a.lastModified!).getTime() - new Date(b.lastModified!).getTime()
  );

  return staleFlags;
}

/**
 * For debugging: show all flags with their status
 */
export async function showAllFlags(config: PostHogFetcherConfig): Promise<void> {
  const apiKey = process.env.POSTHOG_API_KEY;
  const projectIds = config.projectIds;
  const host = config.host || 'https://app.posthog.com';

  if (!apiKey) {
    throw new Error('Missing POSTHOG_API_KEY environment variable');
  }

  if (projectIds.length === 0) {
    throw new Error('Missing fetcher.projectIds in bye-bye-flag-config.json');
  }

  console.error('\n--- All Flags ---');

  for (const projectId of projectIds) {
    const flags = await fetchFlagsForProject(projectId, apiKey, host);
    console.error(`\nProject ${projectId}:`);
    for (const flag of flags.slice(0, 20)) {
      const rollout = getRolloutPercentage(flag);
      const lastMod = new Date(flag.updated_at);
      const hasPayloadFlag = hasPayload(flag);
      const hasVariantsFlag = hasVariants(flag);
      console.error(
        `  ${flag.key}: rollout=${rollout}%, ` +
          `updated=${lastMod.toISOString().split('T')[0]}, ` +
          `payload=${hasPayloadFlag}, variants=${hasVariantsFlag}, ` +
          `active=${flag.active}`
      );
    }
    if (flags.length > 20) {
      console.error(`  ... and ${flags.length - 20} more`);
    }
  }
}
