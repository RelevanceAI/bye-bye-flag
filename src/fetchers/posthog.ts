#!/usr/bin/env npx tsx
/**
 * PostHog Feature Flags Fetcher
 *
 * Fetches stale feature flags from PostHog that are candidates for removal.
 *
 * Criteria for stale flags:
 * - updated_at > 30 days ago
 * - Either 0% or 100% rollout (no complex targeting)
 * - No payload
 *
 * Multi-project support:
 * - Set POSTHOG_PROJECT_IDS as comma-separated list (e.g., "12345,67890")
 * - A flag is only considered stale if it meets criteria in ALL projects where it exists
 *
 * Output: JSON array of flags to remove (to stdout)
 * [
 *   { "key": "my-flag", "keepBranch": "enabled", "reason": "100% rollout for 45 days" },
 *   ...
 * ]
 *
 * Usage:
 *   npx tsx src/fetchers/posthog.ts
 *   npx tsx src/fetchers/posthog.ts --stale-days=60
 *   npx tsx src/fetchers/posthog.ts --show-all  # Show all flags, not just stale ones
 */

// Environment variables loaded via Node's --env-file-if-exists flag (gracefully handles missing .env files)

// Configuration
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_PROJECT_IDS = (process.env.POSTHOG_PROJECT_IDS || process.env.POSTHOG_PROJECT_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://app.posthog.com';

// Default: 30 days
const DEFAULT_STALE_DAYS = 30;

interface PostHogFlag {
  id: number;
  key: string;
  name: string;
  active: boolean;
  deleted: boolean;
  created_at: string;
  updated_at: string;
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
}

interface StaleFlag {
  key: string;
  keepBranch: 'enabled' | 'disabled';
  reason: string;
  lastModified: string;
  rolloutPercentage: number;
  projects: string[];
}

async function fetchFlagsForProject(projectId: string): Promise<PostHogFlag[]> {
  if (!POSTHOG_API_KEY) {
    throw new Error('Missing POSTHOG_API_KEY environment variable');
  }

  const allFlags: PostHogFlag[] = [];
  let url: string | null = `${POSTHOG_HOST}/api/projects/${projectId}/feature_flags/`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${POSTHOG_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PostHog API error for project ${projectId}: ${response.status} ${response.statusText}\n${text}`);
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

function analyzeFlagsAcrossProjects(
  flagsByProject: Map<string, PostHogFlag[]>,
  staleDays: number
): StaleFlag[] {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);

  // Group flags by key across all projects
  const flagsByKey = new Map<string, FlagInfo[]>();

  for (const [projectId, flags] of flagsByProject) {
    for (const flag of flags) {
      const info: FlagInfo = {
        key: flag.key,
        projectId,
        updatedAt: new Date(flag.updated_at),
        rolloutPercentage: getRolloutPercentage(flag),
        hasPayload: hasPayload(flag),
        hasVariants: hasVariants(flag),
        active: flag.active,
        deleted: flag.deleted,
      };

      const existing = flagsByKey.get(flag.key) || [];
      existing.push(info);
      flagsByKey.set(flag.key, existing);
    }
  }

  // Find flags that are stale in ALL projects where they exist
  const staleFlags: StaleFlag[] = [];

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
    // (if updated 30 days ago in one project and 146 days in another, it's been stable for 30 days)
    const latestDate = new Date(Math.max(...infos.map((i) => i.updatedAt.getTime())));
    const daysSinceModified = Math.floor((now.getTime() - latestDate.getTime()) / (24 * 60 * 60 * 1000));

    // Build reason
    const isInactive = infos.some((i) => !i.active);
    const rollout = infos[0].rolloutPercentage;
    const reason = isInactive
      ? `Inactive for ${daysSinceModified} days`
      : `${rollout}% rollout for ${daysSinceModified} days`;

    staleFlags.push({
      key,
      keepBranch,
      reason,
      lastModified: latestDate.toISOString(),
      rolloutPercentage: rollout ?? 0,
      projects: infos.map((i) => i.projectId),
    });
  }

  // Sort by oldest first
  staleFlags.sort((a, b) => new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime());

  return staleFlags;
}

function parseArgs(): { staleDays: number; showAll: boolean } {
  const args = process.argv.slice(2);
  let staleDays = DEFAULT_STALE_DAYS;
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

  if (POSTHOG_PROJECT_IDS.length === 0) {
    throw new Error('Missing POSTHOG_PROJECT_IDS or POSTHOG_PROJECT_ID environment variable');
  }

  console.error(`Fetching feature flags from PostHog...`);
  console.error(`Projects: ${POSTHOG_PROJECT_IDS.join(', ')}`);

  // Fetch flags from all projects
  const flagsByProject = new Map<string, PostHogFlag[]>();
  let totalFlags = 0;

  for (const projectId of POSTHOG_PROJECT_IDS) {
    console.error(`  Fetching project ${projectId}...`);
    const flags = await fetchFlagsForProject(projectId);
    flagsByProject.set(projectId, flags);
    totalFlags += flags.length;
    console.error(`    Found ${flags.length} flags`);
  }

  console.error(`Total: ${totalFlags} flags across ${POSTHOG_PROJECT_IDS.length} project(s)`);

  if (showAll) {
    // Show all flags with their status (not just stale ones)
    console.error('\n--- All Flags ---');
    for (const [projectId, flags] of flagsByProject) {
      console.error(`\nProject ${projectId}:`);
      for (const flag of flags.slice(0, 20)) {
        // Limit output
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
    console.error('');
  }

  const staleFlags = analyzeFlagsAcrossProjects(flagsByProject, staleDays);
  console.error(
    `\nFound ${staleFlags.length} stale flags (>${staleDays} days, 0% or 100% rollout, no payload, consistent across projects)`
  );

  // Output JSON to stdout (for piping to other tools)
  console.log(JSON.stringify(staleFlags, null, 2));
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
