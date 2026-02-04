/**
 * Orchestrator
 *
 * Coordinates fetching stale flags and running removal agents with concurrency control.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execa } from 'execa';
import { fetchFlags, type FlagToRemove, type FetcherConfig } from '../fetchers/index.ts';
import { removeFlag } from '../agent/index.ts';
import { fetchAllFlagPRs, type ExistingPR } from '../agent/git.ts';
import { readConfig } from '../agent/scaffold.ts';
import { createRunLogger, type FlagLogger, type LogStatus } from './logger.ts';
import type { RemovalResult } from '../types.ts';
import { CONFIG } from '../config.ts';

export interface OrchestratorConfig {
  reposDir: string;
  fetcher: FetcherConfig;
  concurrency?: number;
  maxPrs?: number;
  logDir?: string;
  dryRun?: boolean;
}

export interface FlagResult {
  key: string;
  status: LogStatus;
  result?: RemovalResult;
  prUrls?: string[];
  error?: string;
  durationMs?: number;
  skippedReason?: string;
  createdBy?: string; // Flag creator (for reporting)
}

export interface RunSummary {
  startTime: string;
  endTime: string;
  config: {
    concurrency: number;
    maxPrs: number;
    dryRun: boolean;
  };
  input: {
    fetcherType: string;
    totalFetched: number;
    skippedExisting: number;
    processed: number;
  };
  results: {
    prsCreated: number;
    noChanges: number;
    failed: number;
    skipped: number;
    remaining: number;
  };
  flags: FlagResult[];
  logDir: string;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_PRS = 10;
const DEFAULT_LOG_DIR = './bye-bye-flag-logs';

/**
 * Check if a flag exists in a single git repo using git grep on origin's default branch
 */
async function flagExistsInRepo(repoPath: string, flagKey: string): Promise<boolean> {
  // Escape regex special characters in the flag key
  const escapedKey = flagKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Search for flag key in quotes (single, double, or backtick) to avoid false positives
  const pattern = `["'\`]${escapedKey}["'\`]`;

  // Get default branch
  const { stdout: defaultBranch } = await execa('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: repoPath,
    reject: false,
  }).then(
    (r) => ({ stdout: r.stdout.replace('refs/remotes/origin/', '').trim() }),
    () => ({ stdout: 'main' }) // Fallback
  );

  // Search on origin/defaultBranch to check the latest remote code
  const result = await execa('git', ['grep', '-lE', pattern, `origin/${defaultBranch}`], {
    cwd: repoPath,
    reject: false,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Check which flags exist in the codebase (batch check)
 * Returns set of flag keys that have code references
 */
async function filterFlagsWithCodeReferences(
  flags: FlagToRemove[],
  reposDir: string
): Promise<{ flagsWithCode: FlagToRemove[]; flagsWithoutCode: FlagResult[] }> {
  const config = await readConfig(reposDir);
  const repoNames = Object.keys(config.repos);

  console.log('Checking for code references...');

  const flagsWithCode: FlagToRemove[] = [];
  const flagsWithoutCode: FlagResult[] = [];

  // Check each flag in parallel (batch of concurrent checks)
  const BATCH_SIZE = 10;
  for (let i = 0; i < flags.length; i += BATCH_SIZE) {
    const batch = flags.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (flag) => {
        // Check if flag exists in any repo
        for (const repoName of repoNames) {
          const repoPath = path.join(reposDir, repoName);
          try {
            if (await flagExistsInRepo(repoPath, flag.key)) {
              return { flag, hasCode: true };
            }
          } catch {
            // Skip repos we can't check
          }
        }
        return { flag, hasCode: false };
      })
    );

    for (const { flag, hasCode } of results) {
      if (hasCode) {
        flagsWithCode.push(flag);
      } else {
        console.log(`  ○ ${flag.key}: No code references`);
        flagsWithoutCode.push({
          key: flag.key,
          status: 'complete',
          skippedReason: 'No code references found',
          createdBy: flag.createdBy,
        });
      }
    }
  }

  return { flagsWithCode, flagsWithoutCode };
}

/**
 * Fetch latest from origin for all configured repos
 */
async function fetchAllRepos(reposDir: string): Promise<void> {
  const config = await readConfig(reposDir);
  const repoNames = Object.keys(config.repos);

  console.log('Fetching latest from origin...');
  await Promise.all(
    repoNames.map(async (repoName) => {
      const repoPath = path.join(reposDir, repoName);
      console.log(`  Fetching ${repoName}...`);
      try {
        await execa('git', ['fetch', 'origin'], { cwd: repoPath });
      } catch (error) {
        console.warn(`  Warning: Failed to fetch ${repoName}`);
      }
    })
  );
}

/**
 * Run mainSetup commands on the main repos (not worktrees)
 * This runs once per orchestrator run, so worktrees can copy/link node_modules
 */
async function runMainSetup(reposDir: string): Promise<void> {
  const config = await readConfig(reposDir);
  const repoNames = Object.keys(config.repos);

  let hasMainSetup = false;
  for (const repoName of repoNames) {
    const repoConfig = config.repos[repoName];
    if (repoConfig.mainSetup && repoConfig.mainSetup.length > 0) {
      hasMainSetup = true;
      break;
    }
  }

  if (!hasMainSetup) return;

  console.log('\nRunning main setup on repos...');
  for (const repoName of repoNames) {
    const repoConfig = config.repos[repoName];
    const mainSetup = repoConfig.mainSetup;
    if (!mainSetup || mainSetup.length === 0) continue;

    const repoPath = path.join(reposDir, repoName);
    const shellInitCmd = repoConfig.shellInit ?? config.shellInit;
    const shellInit = shellInitCmd ? `${shellInitCmd} && ` : '';

    console.log(`  ${repoName}:`);
    for (const cmd of mainSetup) {
      console.log(`    Running: ${cmd}`);
      try {
        await execa('bash', ['-c', `${shellInit}${cmd}`], {
          cwd: repoPath,
          stdio: 'inherit',
        });
      } catch (error) {
        throw new Error(`Main setup failed for ${repoName}: ${cmd}`);
      }
    }
  }
}

/**
 * Cleans up worktrees for flags whose PRs have been merged or closed
 * Uses the batch PR data we already fetched (efficient)
 */
async function cleanupStaleWorktrees(
  reposDir: string,
  repoNames: string[],
  prsByRepo: Map<string, Map<string, ExistingPR>>
): Promise<void> {
  try {
    const entries = await fs.readdir(CONFIG.worktreeBasePath, { withFileTypes: true });
    const worktreeDirs = entries.filter(
      (e) => e.isDirectory() && e.name.startsWith('remove-flag-')
    );

    if (worktreeDirs.length === 0) return;

    console.log(`\nChecking ${worktreeDirs.length} existing worktree(s) for cleanup...`);

    for (const dir of worktreeDirs) {
      // Extract flag key from directory name (remove-flag-{flagKey})
      const flagKey = dir.name.replace('remove-flag-', '');
      const workspacePath = path.join(CONFIG.worktreeBasePath, dir.name);

      // Check if any repo still has an open PR for this flag (using cached data)
      let hasOpenPR = false;
      for (const repoName of repoNames) {
        const repoPRs = prsByRepo.get(repoName);
        const existingPR = repoPRs?.get(flagKey);
        if (existingPR && existingPR.state === 'OPEN') {
          hasOpenPR = true;
          break;
        }
      }

      if (!hasOpenPR) {
        console.log(`  Cleaning up worktree for "${flagKey}" (PR merged/closed or not found)`);
        try {
          // Clean up each repo's worktree
          for (const repoName of repoNames) {
            const repoPath = path.join(reposDir, repoName);
            const worktreePath = path.join(workspacePath, repoName);
            try {
              await execa('git', ['worktree', 'remove', worktreePath, '--force'], {
                cwd: repoPath,
                reject: false,
              });
            } catch {
              // Ignore errors
            }
          }
          // Remove the workspace directory
          await fs.rm(workspacePath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      } else {
        console.log(`  Keeping worktree for "${flagKey}" (PR still open)`);
      }
    }
  } catch {
    // worktreeBasePath doesn't exist yet, nothing to clean up
  }
}

/**
 * Filter flags that already have PRs (batch API call per repo, then in-memory filtering)
 * Also cleans up stale worktrees using the same PR data
 */
async function filterFlagsWithExistingPRs(
  flags: FlagToRemove[],
  reposDir: string,
  dryRun: boolean
): Promise<{ flagsToProcess: FlagToRemove[]; skippedFlags: FlagResult[] }> {
  const repoConfig = await readConfig(reposDir);
  const repoNames = Object.keys(repoConfig.repos);

  // Fetch all flag PRs from all repos in parallel (much faster than per-flag queries)
  const prsByRepo = new Map<string, Map<string, ExistingPR>>();
  await Promise.all(
    repoNames.map(async (repoName) => {
      const repoPath = path.join(reposDir, repoName);
      console.log(`  Fetching PRs from ${repoName}...`);
      const prs = await fetchAllFlagPRs(repoPath);
      prsByRepo.set(repoName, prs);
      if (prs.size > 0) {
        console.log(`    Found ${prs.size} PRs:`);
        for (const [flagKey, pr] of prs) {
          const status = pr.declined ? 'DECLINED' : pr.state;
          console.log(`      • ${flagKey}: ${pr.url} (${status})`);
        }
      } else {
        console.log(`    No existing PRs`);
      }
    })
  );

  // Clean up stale worktrees using the PR data we just fetched
  if (!dryRun) {
    await cleanupStaleWorktrees(reposDir, repoNames, prsByRepo);
  }

  const flagsToProcess: FlagToRemove[] = [];
  const skippedFlags: FlagResult[] = [];

  // Now filter flags using the cached PR data (fast, in-memory)
  for (const flag of flags) {
    const existingPRs: Array<{ repo: string; pr: ExistingPR }> = [];

    for (const repoName of repoNames) {
      const repoPRs = prsByRepo.get(repoName);
      const existing = repoPRs?.get(flag.key);
      if (existing) {
        existingPRs.push({ repo: repoName, pr: existing });
      }
    }

    const openPRs = existingPRs.filter(({ pr }) => pr.state === 'OPEN');
    const declinedPRs = existingPRs.filter(({ pr }) => pr.declined);

    if (declinedPRs.length > 0) {
      console.log(`  ⊘ ${flag.key}: Declined (skipping)`);
      skippedFlags.push({
        key: flag.key,
        status: 'skipped',
        skippedReason: `Declined: ${declinedPRs.map((p) => p.pr.url).join(', ')}`,
      });
    } else if (openPRs.length > 0) {
      console.log(`  ⊘ ${flag.key}: Open PR exists (skipping)`);
      skippedFlags.push({
        key: flag.key,
        status: 'skipped',
        skippedReason: `Open PR: ${openPRs.map((p) => p.pr.url).join(', ')}`,
      });
    } else {
      flagsToProcess.push(flag);
    }
  }

  return { flagsToProcess, skippedFlags };
}

/**
 * Process flags with concurrency control
 *
 * Uses a simple worker pattern:
 * - Queue starts with min(maxPrs, total) flags
 * - Workers process until queue is empty
 * - When a flag completes WITHOUT creating a PR, another flag is added to the queue
 */
async function processFlags(
  flagsToRun: FlagToRemove[],
  config: {
    reposDir: string;
    concurrency: number;
    dryRun: boolean;
    maxPrs: number;
  },
  runLogger: { createFlagLogger: (key: string) => Promise<FlagLogger> },
  skippedFlags: FlagResult[]
): Promise<{ results: FlagResult[]; remaining: FlagToRemove[] }> {
  // Split flags: initial queue (up to maxPrs) and remaining
  const queue = flagsToRun.slice(0, config.maxPrs);
  const remaining = flagsToRun.slice(config.maxPrs);
  const results: FlagResult[] = [...skippedFlags];
  let prsCreated = 0;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let shouldStop = false;

  console.log(`Processing up to ${config.maxPrs} PRs with concurrency ${config.concurrency}...\n`);

  // Process a single flag, returns the number of PRs created
  const processOneFlag = async (flag: FlagToRemove): Promise<number> => {
    const flagStartTime = Date.now();
    let logger: FlagLogger | null = null;

    try {
      logger = await runLogger.createFlagLogger(flag.key);
      const worktreePath = path.join(CONFIG.worktreeBasePath, `remove-flag-${flag.key}`);
      console.log(`▶ Starting: ${flag.key} (${prsCreated}/${config.maxPrs} PRs)`);
      console.log(`    Keep: ${flag.keepBranch} | Worktree: ${worktreePath}`);
      console.log(`    Log: ${logger.path}`);
      logger.log(`Starting removal of flag: ${flag.key}`);
      logger.log(`Keep branch: ${flag.keepBranch}`);
      if (flag.reason) logger.log(`Reason: ${flag.reason}`);

      const result = await removeFlag({
        flagKey: flag.key,
        keepBranch: flag.keepBranch,
        reposDir: config.reposDir,
        dryRun: config.dryRun,
        skipFetch: true,
        logger: createLoggerFromFlagLogger(logger),
      });

      const durationMs = Date.now() - flagStartTime;

      if (result.status === 'success') {
        consecutiveFailures = 0;
        const prUrls = result.repoResults?.filter((r) => r.prUrl).map((r) => r.prUrl!) || [];
        if (prUrls.length > 0) {
          console.log(`✓ Complete: ${flag.key} (${prUrls.length} PR(s), ${prsCreated + prUrls.length}/${config.maxPrs} total, ${formatDuration(durationMs)})`);
          await logger.finish('complete', `${prUrls.length} PR(s) created`);
        } else {
          console.log(`○ Complete: ${flag.key} (no changes needed, ${formatDuration(durationMs)})`);
          await logger.finish('complete', 'No changes needed');
        }
        results.push({ key: flag.key, status: 'complete', result, prUrls, durationMs });
        return prUrls.length;
      } else if (result.status === 'refused') {
        consecutiveFailures = 0;
        console.log(`⊘ Skipped: ${flag.key} (${result.refusalReason})`);
        await logger.finish('skipped', result.refusalReason);
        results.push({ key: flag.key, status: 'skipped', result, skippedReason: result.refusalReason, durationMs });
        return 0;
      } else {
        consecutiveFailures++;
        console.log(`✗ Failed: ${flag.key} (${result.error})`);
        await logger.finish('failed', result.error);
        results.push({ key: flag.key, status: 'failed', result, error: result.error, durationMs });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`\n⚠ Stopping: ${MAX_CONSECUTIVE_FAILURES} consecutive failures (likely systemic issue)`);
          shouldStop = true;
        }
        return 0;
      }
    } catch (error) {
      consecutiveFailures++;
      const durationMs = Date.now() - flagStartTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`✗ Failed: ${flag.key} (${errorMsg})`);
      if (logger) {
        logger.error(errorMsg);
        await logger.finish('failed', errorMsg);
      }
      results.push({ key: flag.key, status: 'failed', error: errorMsg, durationMs });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`\n⚠ Stopping: ${MAX_CONSECUTIVE_FAILURES} consecutive failures (likely systemic issue)`);
        shouldStop = true;
      }
      return 0;
    }
  };

  // Worker: pulls from queue until empty
  const worker = async (): Promise<void> => {
    while (!shouldStop) {
      const flag = queue.shift();
      if (!flag) break;

      const prsFromFlag = await processOneFlag(flag);
      prsCreated += prsFromFlag;

      // If no PR was created, add another flag to the queue (if available)
      if (prsFromFlag === 0 && remaining.length > 0 && !shouldStop) {
        queue.push(remaining.shift()!);
      }
    }
  };

  // Start workers
  const numWorkers = Math.min(config.concurrency, queue.length);
  await Promise.all(Array(numWorkers).fill(null).map(() => worker()));

  // Any unprocessed queue items go back to remaining
  remaining.unshift(...queue);

  if (remaining.length > 0 && !shouldStop) {
    console.log(`\nReached ${config.maxPrs} PRs limit. ${remaining.length} flags remaining for next run.`);
  } else if (remaining.length > 0 && shouldStop) {
    console.log(`\n${remaining.length} flags not attempted due to consecutive failures.`);
  }

  return { results, remaining };
}

/**
 * Creates a Logger adapter from a FlagLogger
 */
function createLoggerFromFlagLogger(flagLogger: FlagLogger) {
  return {
    log: (message: string) => flagLogger.log(message),
    error: (message: string) => flagLogger.error(message),
  };
}

/**
 * Run the orchestrator
 */
export async function run(config: OrchestratorConfig): Promise<RunSummary> {
  const startTime = new Date();
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const maxPrs = config.maxPrs ?? DEFAULT_MAX_PRS;
  const logDir = config.logDir ?? DEFAULT_LOG_DIR;
  const dryRun = config.dryRun ?? false;

  console.log(`\n${'═'.repeat(60)}`);
  console.log('                    bye-bye-flag Orchestrator');
  console.log(`${'═'.repeat(60)}`);
  console.log(`Repos directory: ${config.reposDir}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Max PRs: ${maxPrs}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Create run logger
  const runLogger = await createRunLogger(logDir);
  console.log(`Logs: ${runLogger.runDir}\n`);

  // Fetch latest from git and run main setup
  if (!dryRun) {
    await fetchAllRepos(config.reposDir);
    await runMainSetup(config.reposDir);
  }

  // Fetch flags from feature flag system
  console.log('\nFetching stale flags...');
  if (config.fetcher.type === 'manual') {
    throw new Error('Manual fetcher requires --input flag');
  }

  const flags = await fetchFlags(config.fetcher);
  console.log(`Fetched ${flags.length} stale flags\n`);

  if (flags.length === 0) {
    console.log('No stale flags found. Nothing to do.');
    const summary = createSummary(startTime, config, flags, [], runLogger.runDir, 0);
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Filter out flags with existing open PRs
  console.log('Checking for existing PRs...');
  const { flagsToProcess: flagsAfterPrCheck, skippedFlags } = await filterFlagsWithExistingPRs(flags, config.reposDir, dryRun);

  console.log(`  ${flagsAfterPrCheck.length} flags passed PR check (${skippedFlags.length} skipped)\n`);

  if (flagsAfterPrCheck.length === 0) {
    console.log('No flags to process after PR filtering. Nothing to do.');
    const summary = createSummary(startTime, config, flags, skippedFlags, runLogger.runDir, 0);
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Filter out flags with no code references
  const { flagsWithCode, flagsWithoutCode } = await filterFlagsWithCodeReferences(flagsAfterPrCheck, config.reposDir);
  const allSkipped = [...skippedFlags, ...flagsWithoutCode];

  console.log(`  ${flagsWithCode.length} flags have code references (${flagsWithoutCode.length} have no code)\n`);

  if (flagsWithCode.length === 0) {
    console.log('No flags with code references to process. Nothing to do.');
    const summary = createSummary(startTime, config, flags, allSkipped, runLogger.runDir, 0);
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Process flags until we hit maxPrs PRs created
  const { results, remaining } = await processFlags(
    flagsWithCode,
    { reposDir: config.reposDir, concurrency, dryRun, maxPrs },
    runLogger,
    allSkipped
  );

  // Generate summary
  const summary = createSummary(startTime, config, flags, results, runLogger.runDir, remaining.length);
  await runLogger.writeSummary(summary);

  // Print summary
  printSummary(summary);

  return summary;
}

/**
 * Run with flags loaded from a file (instead of fetcher)
 */
export async function runWithInput(
  config: Omit<OrchestratorConfig, 'fetcher'> & { inputFile: string }
): Promise<RunSummary> {
  const content = await fs.readFile(config.inputFile, 'utf-8');
  const flags: FlagToRemove[] = JSON.parse(content);

  const fullConfig: OrchestratorConfig = {
    ...config,
    fetcher: { type: 'manual' },
  };

  return runWithFlags(fullConfig, flags);
}

/**
 * Internal: run with pre-loaded flags
 */
async function runWithFlags(config: OrchestratorConfig, flags: FlagToRemove[]): Promise<RunSummary> {
  const startTime = new Date();
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const maxPrs = config.maxPrs ?? DEFAULT_MAX_PRS;
  const logDir = config.logDir ?? DEFAULT_LOG_DIR;
  const dryRun = config.dryRun ?? false;

  console.log(`\n${'═'.repeat(60)}`);
  console.log('                    bye-bye-flag Orchestrator');
  console.log(`${'═'.repeat(60)}`);
  console.log(`Repos directory: ${config.reposDir}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Max PRs: ${maxPrs}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Input: file (${flags.length} flags)`);
  console.log(`${'═'.repeat(60)}\n`);

  const runLogger = await createRunLogger(logDir);
  console.log(`Logs: ${runLogger.runDir}\n`);

  // Fetch latest from git and run main setup
  if (!dryRun) {
    await fetchAllRepos(config.reposDir);
    await runMainSetup(config.reposDir);
  }

  if (flags.length === 0) {
    console.log('No flags in input. Nothing to do.');
    const summary = createSummary(startTime, config, flags, [], runLogger.runDir, 0);
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Filter out flags with existing open PRs
  console.log('\nChecking for existing PRs...');
  const { flagsToProcess: flagsAfterPrCheck, skippedFlags } = await filterFlagsWithExistingPRs(flags, config.reposDir, dryRun);

  console.log(`  ${flagsAfterPrCheck.length} flags passed PR check (${skippedFlags.length} skipped)\n`);

  if (flagsAfterPrCheck.length === 0) {
    console.log('No flags to process after PR filtering. Nothing to do.');
    const summary = createSummary(startTime, config, flags, skippedFlags, runLogger.runDir, 0);
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Filter out flags with no code references
  const { flagsWithCode, flagsWithoutCode } = await filterFlagsWithCodeReferences(flagsAfterPrCheck, config.reposDir);
  const allSkipped = [...skippedFlags, ...flagsWithoutCode];

  console.log(`  ${flagsWithCode.length} flags have code references (${flagsWithoutCode.length} have no code)\n`);

  if (flagsWithCode.length === 0) {
    console.log('No flags with code references to process. Nothing to do.');
    const summary = createSummary(startTime, config, flags, allSkipped, runLogger.runDir, 0);
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Process flags until we hit maxPrs PRs created
  const { results, remaining } = await processFlags(
    flagsWithCode,
    { reposDir: config.reposDir, concurrency, dryRun, maxPrs },
    runLogger,
    allSkipped
  );

  // Generate summary
  const summary = createSummary(startTime, config, flags, results, runLogger.runDir, remaining.length);
  await runLogger.writeSummary(summary);

  // Print summary
  printSummary(summary);

  return summary;
}

function createSummary(
  startTime: Date,
  config: OrchestratorConfig,
  allFlags: FlagToRemove[],
  results: FlagResult[],
  logDir: string,
  remainingCount: number
): RunSummary {
  const endTime = new Date();

  const prsCreated = results.filter(
    (r) => r.status === 'complete' && r.prUrls && r.prUrls.length > 0
  ).length;
  const noChanges = results.filter(
    (r) => r.status === 'complete' && (!r.prUrls || r.prUrls.length === 0)
  ).length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  return {
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    config: {
      concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
      maxPrs: config.maxPrs ?? DEFAULT_MAX_PRS,
      dryRun: config.dryRun ?? false,
    },
    input: {
      fetcherType: config.fetcher.type,
      totalFetched: allFlags.length,
      skippedExisting: skipped,
      processed: results.length - skipped,
    },
    results: {
      prsCreated,
      noChanges,
      failed,
      skipped,
      remaining: remainingCount,
    },
    flags: results,
    logDir,
  };
}

function printSummary(summary: RunSummary): void {
  const duration = new Date(summary.endTime).getTime() - new Date(summary.startTime).getTime();

  console.log(`\n${'═'.repeat(60)}`);
  console.log('                    bye-bye-flag Run Complete');
  console.log(`${'═'.repeat(60)}`);
  console.log(`Fetcher: ${summary.input.fetcherType} (found ${summary.input.totalFetched} stale flags)`);
  console.log(`Duration: ${formatDuration(duration)}`);
  console.log(`Processed: ${summary.input.processed} flags`);
  console.log('');
  console.log(`  ✓ ${summary.results.prsCreated} PRs created`);
  console.log(`  ○ ${summary.results.noChanges} no code references`);
  console.log(`  ✗ ${summary.results.failed} failed`);
  console.log(`  ⊘ ${summary.results.skipped} skipped`);

  if (summary.results.remaining > 0) {
    console.log(`  … ${summary.results.remaining} remaining (--max-prs limit)`);
  }

  const prsCreatedFlags = summary.flags.filter((f) => f.prUrls && f.prUrls.length > 0);
  if (prsCreatedFlags.length > 0) {
    console.log('\nPRs created:');
    for (const flag of prsCreatedFlags) {
      for (const url of flag.prUrls!) {
        console.log(`  • ${flag.key}: ${url}`);
      }
    }
  }

  const skippedFlags = summary.flags.filter((f) => f.status === 'skipped' && f.skippedReason);
  if (skippedFlags.length > 0) {
    console.log('\nSkipped:');
    for (const flag of skippedFlags) {
      console.log(`  • ${flag.key}: ${flag.skippedReason}`);
    }
  }

  const failedFlags = summary.flags.filter((f) => f.status === 'failed');
  if (failedFlags.length > 0) {
    console.log('\nFailed:');
    for (const flag of failedFlags) {
      console.log(`  • ${flag.key}: ${flag.error}`);
    }
  }

  // Show flags with no code references (safe to remove from feature flag system)
  // Group by creator so it's easy to notify flag owners
  const noCodeFlags = summary.flags.filter(
    (f) => f.status === 'complete' && f.skippedReason === 'No code references found'
  );
  if (noCodeFlags.length > 0) {
    console.log('\nNo code references (safe to remove from feature flag system):');

    // Group by creator
    const byCreator = new Map<string, string[]>();
    for (const flag of noCodeFlags) {
      const creator = flag.createdBy || 'Unknown';
      const flags = byCreator.get(creator) || [];
      flags.push(flag.key);
      byCreator.set(creator, flags);
    }

    // Sort by creator name, with "Unknown" last
    const sortedCreators = [...byCreator.keys()].sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return a.localeCompare(b);
    });

    for (const creator of sortedCreators) {
      const flags = byCreator.get(creator)!;
      console.log(`  ${creator}:`);
      for (const key of flags) {
        console.log(`    • ${key}`);
      }
    }
  }

  console.log(`\nLogs: ${summary.logDir}`);

  if (summary.results.remaining > 0) {
    console.log(`\nTo continue processing remaining flags, run the command again.`);
  }

  console.log('');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export { runWithFlags };
