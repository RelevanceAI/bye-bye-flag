/**
 * Orchestrator
 *
 * Coordinates fetching stale flags and running removal agents with concurrency control.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execa } from 'execa';
import { z } from 'zod';
import { fetchFlags, type FlagToRemove, type FetcherConfig } from '../fetchers/index.ts';
import { removeFlag } from '../agent/index.ts';
import { fetchAllFlagPRs, type ExistingPR } from '../agent/git.ts';
import { getRepoBaseBranch, readWorkspaceMetadata } from '../agent/scaffold.ts';
import { createRunLogger, type FlagLogger, type LogStatus } from './logger.ts';
import type { RemovalResult } from '../types.ts';
import { consoleLogger, type Logger } from '../types.ts';
import { CONFIG } from '../config.ts';
import type { ConfigContext, RuntimeSettings } from '../config-context.ts';
import { getRuntimeSettings } from '../config-context.ts';
import { flagExistsInRepo, fetchAllRepos } from '../git-utils.ts';

export interface OrchestratorConfig {
  configContext: ConfigContext;
  fetcher: FetcherConfig;
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
    noCodeReferences: number;
    failed: number;
    skipped: number;
    remaining: number;
  };
  flags: FlagResult[];
  logDir: string;
}

type FlagWithCodeReferences = FlagToRemove & { reposWithCode: string[] };

/**
 * Check which flags exist in the codebase (batch check)
 * Returns set of flag keys that have code references
 */
async function filterFlagsWithCodeReferences(
  flags: FlagToRemove[],
  configContext: ConfigContext,
  logger: Logger
): Promise<{ flagsWithCode: FlagWithCodeReferences[]; flagsWithoutCode: FlagResult[] }> {
  const { reposDir, config } = configContext;
  const repoNames = Object.keys(config.repos);

  logger.log('Checking for code references...');

  const flagsWithCode: FlagWithCodeReferences[] = [];
  const flagsWithoutCode: FlagResult[] = [];

  const baseBranchByRepo = new Map<string, string>();
  for (const repoName of repoNames) {
    baseBranchByRepo.set(repoName, getRepoBaseBranch(config, repoName));
  }

  // Check each flag in parallel (batch of concurrent checks)
  const BATCH_SIZE = 10;
  for (let i = 0; i < flags.length; i += BATCH_SIZE) {
    const batch = flags.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (flag) => {
        const reposWithCode: string[] = [];

        // Check if flag exists in any repo
        for (const repoName of repoNames) {
          const repoPath = path.join(reposDir, repoName);
          try {
            const baseBranch = baseBranchByRepo.get(repoName);
            if (!baseBranch) {
              throw new Error(`Missing baseBranch configuration for repo "${repoName}"`);
            }
            if (await flagExistsInRepo(repoPath, flag.key, baseBranch)) {
              reposWithCode.push(repoName);
            }
          } catch {
            // Skip repos we can't check
          }
        }

        return { flag, reposWithCode };
      })
    );

    for (const { flag, reposWithCode } of results) {
      if (reposWithCode.length > 0) {
        flagsWithCode.push({ ...flag, reposWithCode });
      } else {
        logger.log(`  ○ ${flag.key}: No code references`);
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
 * Run mainSetup commands on the main repos (not worktrees)
 * This runs once per orchestrator run, so worktrees can copy/link node_modules
 */
async function runMainSetup(configContext: ConfigContext, logger: Logger): Promise<void> {
  const { reposDir, config } = configContext;
  const repoNames = Object.keys(config.repos);

  let hasMainSetup = false;
  for (const repoName of repoNames) {
    const repoEntry = config.repos[repoName];
    const mainSetup =
      repoEntry.mainSetup !== undefined ? repoEntry.mainSetup : config.repoDefaults?.mainSetup;
    if (mainSetup && mainSetup.length > 0) {
      hasMainSetup = true;
      break;
    }
  }

  if (!hasMainSetup) return;

  logger.log('\nRunning main setup on repos...');
  for (const repoName of repoNames) {
    const repoEntry = config.repos[repoName];
    const mainSetup =
      repoEntry.mainSetup !== undefined ? repoEntry.mainSetup : config.repoDefaults?.mainSetup;
    if (!mainSetup || mainSetup.length === 0) continue;

    const repoPath = path.join(reposDir, repoName);
    const shellInitCmd = repoEntry.shellInit ?? config.repoDefaults?.shellInit;
    const shellInit = shellInitCmd ? `${shellInitCmd} && ` : '';

    logger.log(`  ${repoName}:`);
    for (const cmd of mainSetup) {
      logger.log(`    Running: ${cmd}`);
      try {
        await execa('bash', ['-c', `${shellInit}${cmd}`], {
          cwd: repoPath,
          stdio: 'inherit',
        });
      } catch {
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
  worktreeBasePath: string,
  reposDir: string,
  repoNames: string[],
  prsByRepo: Map<string, Map<string, ExistingPR>>,
  logger: Logger
): Promise<void> {
  const normalizePath = async (value: string): Promise<string> => {
    try {
      return await fs.realpath(value);
    } catch {
      return path.resolve(value);
    }
  };

  const getRegisteredWorktrees = async (repoPath: string): Promise<Set<string>> => {
    const result = await execa('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      reject: false,
    });
    const registered = new Set<string>();
    if (result.exitCode !== 0) return registered;
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const worktree = line.slice('worktree '.length).trim();
      if (!worktree) continue;
      registered.add(await normalizePath(worktree));
    }
    return registered;
  };

  try {
    const entries = await fs.readdir(worktreeBasePath, { withFileTypes: true });
    const worktreeDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('remove-flag-'));

    if (worktreeDirs.length === 0) return;

    logger.log(`\nChecking ${worktreeDirs.length} existing worktree(s) for cleanup...`);
    const normalizedReposDir = await normalizePath(reposDir);
    const registeredByRepo = new Map<string, Set<string>>();
    await Promise.all(
      repoNames.map(async (repoName) => {
        const repoPath = path.join(reposDir, repoName);
        registeredByRepo.set(repoName, await getRegisteredWorktrees(repoPath));
      })
    );

    for (const dir of worktreeDirs) {
      // Extract flag key from directory name (remove-flag-{flagKey})
      const flagKey = dir.name.replace('remove-flag-', '');
      const workspacePath = path.join(worktreeBasePath, dir.name);

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
        logger.log(`  Cleaning up worktree for "${flagKey}" (PR merged/closed or not found)`);
        try {
          const metadata = await readWorkspaceMetadata(workspacePath);
          const metadataReposDir =
            metadata && typeof metadata.reposDir === 'string' ? await normalizePath(metadata.reposDir) : null;
          const workspaceOwnedByCurrentRun = metadataReposDir === normalizedReposDir;

          if (metadata && !workspaceOwnedByCurrentRun) {
            logger.log(`  Skipping "${flagKey}" (workspace belongs to another repos root)`);
            continue;
          }

          const registeredForCurrentRepos: Array<{ repoName: string; worktreePath: string }> = [];
          for (const repoName of repoNames) {
            const worktreePath = path.join(workspacePath, repoName);
            const normalizedWorktreePath = await normalizePath(worktreePath);
            if (registeredByRepo.get(repoName)?.has(normalizedWorktreePath)) {
              registeredForCurrentRepos.push({ repoName, worktreePath });
            }
          }

          if (!workspaceOwnedByCurrentRun && registeredForCurrentRepos.length === 0) {
            // Legacy workspace (no metadata) or foreign directory that is not registered
            // in the current clone's worktree list. Never delete this folder.
            logger.log(`  Skipping "${flagKey}" (not registered to current repos clone)`);
            continue;
          }

          let removalFailed = false;
          // Clean up each repo's worktree
          for (const { repoName, worktreePath } of registeredForCurrentRepos) {
            const repoPath = path.join(reposDir, repoName);
            const removeResult = await execa('git', ['worktree', 'remove', worktreePath, '--force'], {
              cwd: repoPath,
              reject: false,
            });
            if (removeResult.exitCode !== 0) {
              removalFailed = true;
              logger.error(
                `  Warning: Failed to remove worktree "${worktreePath}" from ${repoName}; leaving workspace untouched`
              );
            }
          }

          if (removalFailed) {
            continue;
          }

          if (workspaceOwnedByCurrentRun || registeredForCurrentRepos.length > 0) {
            // Remove workspace only after registered worktrees were removed successfully.
            await fs.rm(workspacePath, { recursive: true, force: true });
          }
        } catch {
          // Ignore cleanup errors
        }
      } else {
        logger.log(`  Keeping worktree for "${flagKey}" (PR still open)`);
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
  configContext: ConfigContext,
  dryRun: boolean,
  logger: Logger
): Promise<{ flagsToProcess: FlagToRemove[]; skippedFlags: FlagResult[] }> {
  const { reposDir, config } = configContext;
  const repoNames = Object.keys(config.repos);
  const worktreeBasePath = config.worktrees?.basePath ?? CONFIG.worktreeBasePath;

  // Fetch all flag PRs from all repos in parallel (much faster than per-flag queries)
  const prsByRepo = new Map<string, Map<string, ExistingPR>>();
  await Promise.all(
    repoNames.map(async (repoName) => {
      const repoPath = path.join(reposDir, repoName);
      logger.log(`  Fetching PRs from ${repoName}...`);
      const prs = await fetchAllFlagPRs(repoPath);
      prsByRepo.set(repoName, prs);
      if (prs.size > 0) {
        const totalPRs = Array.from(prs.values()).reduce(
          (sum, pr) => sum + Math.max(pr.history.length, 1),
          0
        );
        logger.log(`    Found ${totalPRs} PR(s) across ${prs.size} flag key(s):`);
        for (const [flagKey, pr] of prs) {
          const status = pr.declined ? 'DECLINED' : pr.state;
          logger.log(`      • ${flagKey}: ${pr.url} (${status})`);
          if (pr.history.length > 1) {
            for (const older of pr.history.slice(1)) {
              const olderStatus = older.declined ? 'DECLINED' : older.state;
              const createdAt = older.createdAt ? `, created ${older.createdAt}` : '';
              logger.log(`        - older: ${older.url} (${olderStatus}${createdAt})`);
            }
          }
        }
      } else {
        logger.log(`    No existing PRs`);
      }
    })
  );

  // Clean up stale worktrees using the PR data we just fetched
  if (!dryRun) {
    await cleanupStaleWorktrees(worktreeBasePath, reposDir, repoNames, prsByRepo, logger);
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
      logger.log(`  ⊘ ${flag.key}: Declined (skipping)`);
      skippedFlags.push({
        key: flag.key,
        status: 'skipped',
        skippedReason: `Declined: ${declinedPRs.map((p) => p.pr.url).join(', ')}`,
      });
    } else if (openPRs.length > 0) {
      logger.log(`  ⊘ ${flag.key}: Open PR exists (skipping)`);
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
 * Process flags with concurrency control and a PR budget.
 *
 * We reserve PR budget per flag based on the number of repos where the flag key
 * has code references (an upper bound on how many PRs that flag can create).
 * If the agent produces fewer PRs than reserved, we refund the unused budget so
 * we can keep processing more flags. In dry-run mode, we treat reserved budget
 * as spent so `maxPrs` still caps the amount of work performed.
 */
async function processFlags(
  flagsToRun: FlagWithCodeReferences[],
  config: {
    configContext: ConfigContext;
    concurrency: number;
    dryRun: boolean;
    maxPrs: number;
  },
  runLogger: { createFlagLogger: (key: string) => Promise<FlagLogger> },
  skippedFlags: FlagResult[],
  logger: Logger
): Promise<{ results: FlagResult[]; remaining: FlagWithCodeReferences[] }> {
  const { configContext } = config;
  const { config: byeByeConfig } = configContext;
  const agentKind = byeByeConfig.agent?.type ?? 'claude';
  const worktreeBasePath = byeByeConfig.worktrees?.basePath ?? CONFIG.worktreeBasePath;

  const queue = [...flagsToRun];
  const results: FlagResult[] = [...skippedFlags];
  let remainingPrBudget = config.maxPrs;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let shouldStop = false;

  logger.log(`Processing up to ${config.maxPrs} PRs with concurrency ${config.concurrency}...\n`);

  if (config.maxPrs <= 0) {
    return { results, remaining: queue };
  }

  // Process a single flag, returns the number of PRs created
  const processOneFlag = async (flag: FlagToRemove): Promise<number> => {
    const flagStartTime = Date.now();
    let flagLogger: FlagLogger | null = null;

    try {
      flagLogger = await runLogger.createFlagLogger(flag.key);
      const worktreePath = path.join(worktreeBasePath, `remove-flag-${flag.key}`);
      logger.log(
        `▶ Starting (${agentKind}): ${flag.key} (${config.maxPrs - remainingPrBudget}/${config.maxPrs} PRs reserved)`
      );
      logger.log(`    Keep: ${flag.keepBranch} | Worktree: ${worktreePath}`);
      logger.log(`    Log: ${flagLogger.path}`);
      flagLogger.log(`Starting removal of flag: ${flag.key}`);
      flagLogger.log(`Agent: ${agentKind}`);
      flagLogger.log(`Keep branch: ${flag.keepBranch}`);
      if (flag.reason) flagLogger.log(`Reason: ${flag.reason}`);

      const result = await removeFlag({
        flagKey: flag.key,
        keepBranch: flag.keepBranch,
        configContext,
        flagCreatedBy: flag.createdBy,
        dryRun: config.dryRun,
        skipFetch: true,
        logger: createLoggerFromFlagLogger(flagLogger),
      });

      const durationMs = Date.now() - flagStartTime;

      if (result.status === 'success') {
        consecutiveFailures = 0;
        const prUrls = result.repoResults?.filter((r) => r.prUrl).map((r) => r.prUrl!) || [];
        if (config.dryRun) {
          logger.log(`○ Complete: ${flag.key} (dry-run, ${formatDuration(durationMs)})`);
          await flagLogger.finish('complete', 'Dry-run complete');
        } else if (prUrls.length > 0) {
          logger.log(`✓ Complete: ${flag.key} (${prUrls.length} PR(s), ${formatDuration(durationMs)})`);
          await flagLogger.finish('complete', `${prUrls.length} PR(s) created`);
        } else {
          logger.log(`○ Complete: ${flag.key} (no changes needed, ${formatDuration(durationMs)})`);
          await flagLogger.finish('complete', 'No changes needed');
        }
        results.push({
          key: flag.key,
          status: 'complete',
          result,
          prUrls,
          durationMs,
          createdBy: flag.createdBy,
        });
        return prUrls.length;
      } else if (result.status === 'refused') {
        consecutiveFailures = 0;
        logger.log(`⊘ Skipped: ${flag.key} (${result.refusalReason})`);
        await flagLogger.finish('skipped', result.refusalReason);
        results.push({
          key: flag.key,
          status: 'skipped',
          result,
          skippedReason: result.refusalReason,
          durationMs,
          createdBy: flag.createdBy,
        });
        return 0;
      } else {
        consecutiveFailures++;
        logger.log(`✗ Failed: ${flag.key} (${result.error})`);
        await flagLogger.finish('failed', result.error);
        results.push({
          key: flag.key,
          status: 'failed',
          result,
          error: result.error,
          durationMs,
          createdBy: flag.createdBy,
        });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.log(
            `\n⚠ Stopping: ${MAX_CONSECUTIVE_FAILURES} consecutive failures (likely systemic issue)`
          );
          shouldStop = true;
        }
        return 0;
      }
    } catch (error) {
      consecutiveFailures++;
      const durationMs = Date.now() - flagStartTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.log(`✗ Failed: ${flag.key} (${errorMsg})`);
      if (flagLogger) {
        flagLogger.error(errorMsg);
        await flagLogger.finish('failed', errorMsg);
      }
      results.push({
        key: flag.key,
        status: 'failed',
        error: errorMsg,
        durationMs,
        createdBy: flag.createdBy,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.log(`\n⚠ Stopping: ${MAX_CONSECUTIVE_FAILURES} consecutive failures (likely systemic issue)`);
        shouldStop = true;
      }
      return 0;
    }
  };

  const inFlight = new Set<Promise<void>>();

  const tryStartOne = (): boolean => {
    if (shouldStop) return false;
    if (inFlight.size >= config.concurrency) return false;
    if (remainingPrBudget <= 0) return false;
    if (queue.length === 0) return false;

    // Pick the next flag that fits in the remaining PR budget. This avoids getting stuck
    // if the head of the queue would exceed the remaining budget.
    const nextIndex = queue.findIndex((f) => f.reposWithCode.length <= remainingPrBudget);
    if (nextIndex === -1) return false;

    const flag = queue.splice(nextIndex, 1)[0];
    const reserved = Math.max(1, flag.reposWithCode.length);
    remainingPrBudget -= reserved;

    const task = (async () => {
      const prsFromFlag = await processOneFlag(flag);

      // In dry-run mode we never create PRs, but we still want maxPrs to cap how
      // much work we do. So we treat reserved budget as "spent" and do not refund.
      if (!config.dryRun) {
        const unused = reserved - prsFromFlag;
        if (unused > 0) remainingPrBudget += unused;
      }
    })().finally(() => {
      inFlight.delete(task);
    });

    inFlight.add(task);
    return true;
  };

  while (!shouldStop) {
    // Fill up the pool
    while (tryStartOne()) {
      // keep starting
    }

    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
  }

  // Wait for anything still in flight
  await Promise.all(inFlight);

  if (queue.length > 0 && !shouldStop) {
    const reason =
      remainingPrBudget <= 0 ? `Reached ${config.maxPrs} PRs limit` : 'No remaining budget to fit next flag';
    logger.log(`\n${reason}. ${queue.length} flag(s) remaining for next run.`);
  } else if (queue.length > 0 && shouldStop) {
    logger.log(`\n${queue.length} flag(s) not attempted due to consecutive failures.`);
  }

  return { results, remaining: queue };
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
 * Zod schema for validating --input flag files
 */
const FlagToRemoveSchema = z.array(
  z.object({
    key: z.string().min(1),
    keepBranch: z.enum(['enabled', 'disabled']),
    reason: z.string().optional(),
    lastModified: z.string().optional(),
    createdBy: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
);

/**
 * Run the orchestrator with flags from a fetcher
 */
export async function run(config: OrchestratorConfig): Promise<RunSummary> {
  // Fetch flags from feature flag system
  if (config.fetcher.type === 'manual') {
    throw new Error('Manual fetcher requires --input flag');
  }

  const logger = consoleLogger;
  logger.log('\nFetching stale flags...');
  const flags = await fetchFlags(config.fetcher);
  logger.log(`Fetched ${flags.length} stale flags\n`);

  return runWithFlags(config, flags, config.fetcher.type, logger);
}

/**
 * Run with flags loaded from a file (instead of fetcher)
 */
export async function runWithInput(
  config: Omit<OrchestratorConfig, 'fetcher'> & { inputFile: string }
): Promise<RunSummary> {
  const content = await fs.readFile(config.inputFile, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse input file as JSON: ${config.inputFile}`);
  }

  const result = FlagToRemoveSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid input file: ${config.inputFile}\n${issues}`);
  }

  const fullConfig: OrchestratorConfig = {
    ...config,
    fetcher: { type: 'manual' },
  };

  return runWithFlags(fullConfig, result.data, `file (${config.inputFile})`, consoleLogger);
}

/**
 * Internal: shared orchestration logic for both fetcher and file-based runs
 */
async function runWithFlags(
  config: OrchestratorConfig,
  flags: FlagToRemove[],
  fetcherLabel: string,
  logger: Logger
): Promise<RunSummary> {
  const startTime = new Date();
  const { configContext } = config;
  const { reposDir } = configContext;
  const runtime = getRuntimeSettings(configContext.config);
  const { concurrency, maxPrs, logDir } = runtime;
  const dryRun = config.dryRun ?? false;

  logger.log(`\n${'═'.repeat(60)}`);
  logger.log('                    bye-bye-flag Orchestrator');
  logger.log(`${'═'.repeat(60)}`);
  logger.log(`Repos directory: ${reposDir}`);
  logger.log(`Concurrency: ${concurrency}`);
  logger.log(`Max PRs: ${maxPrs}`);
  logger.log(`Dry run: ${dryRun}`);
  logger.log(`Input: ${fetcherLabel} (${flags.length} flags)`);
  logger.log(`${'═'.repeat(60)}\n`);

  const runLogger = await createRunLogger(logDir);
  logger.log(`Logs: ${runLogger.runDir}\n`);

  // Fetch latest from git and run main setup
  if (!dryRun) {
    logger.log('Fetching latest from origin...');
    await fetchAllRepos(configContext, logger);
    await runMainSetup(configContext, logger);
  }

  if (flags.length === 0) {
    logger.log('No flags to process. Nothing to do.');
    const summary = createSummary(startTime, fetcherLabel, flags, [], runLogger.runDir, 0, runtime, dryRun);
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Filter out flags with existing open PRs
  logger.log('Checking for existing PRs...');
  const { flagsToProcess: flagsAfterPrCheck, skippedFlags } = await filterFlagsWithExistingPRs(
    flags,
    configContext,
    dryRun,
    logger
  );

  logger.log(`  ${flagsAfterPrCheck.length} flags passed PR check (${skippedFlags.length} skipped)\n`);

  if (flagsAfterPrCheck.length === 0) {
    logger.log('No flags to process after PR filtering. Nothing to do.');
    const summary = createSummary(
      startTime,
      fetcherLabel,
      flags,
      skippedFlags,
      runLogger.runDir,
      0,
      runtime,
      dryRun
    );
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Filter out flags with no code references
  const { flagsWithCode, flagsWithoutCode } = await filterFlagsWithCodeReferences(
    flagsAfterPrCheck,
    configContext,
    logger
  );
  const allSkipped = [...skippedFlags, ...flagsWithoutCode];

  logger.log(
    `  ${flagsWithCode.length} flags have code references (${flagsWithoutCode.length} have no code)\n`
  );

  if (flagsWithCode.length === 0) {
    logger.log('No flags with code references to process. Nothing to do.');
    const summary = createSummary(
      startTime,
      fetcherLabel,
      flags,
      allSkipped,
      runLogger.runDir,
      0,
      runtime,
      dryRun
    );
    await runLogger.writeSummary(summary);
    return summary;
  }

  // Process flags until we hit maxPrs PRs created
  const { results, remaining } = await processFlags(
    flagsWithCode,
    { configContext, concurrency, dryRun, maxPrs },
    runLogger,
    allSkipped,
    logger
  );

  // Generate summary
  const summary = createSummary(
    startTime,
    fetcherLabel,
    flags,
    results,
    runLogger.runDir,
    remaining.length,
    runtime,
    dryRun
  );
  await runLogger.writeSummary(summary);

  // Print summary
  printSummary(summary, logger);

  return summary;
}

function createSummary(
  startTime: Date,
  fetcherType: string,
  allFlags: FlagToRemove[],
  results: FlagResult[],
  logDir: string,
  remainingCount: number,
  runtime: RuntimeSettings,
  dryRun: boolean
): RunSummary {
  const endTime = new Date();

  const prsCreated = results.reduce((sum, r) => sum + (r.prUrls?.length ?? 0), 0);
  const noCodeReferences = results.filter(
    (r) => r.status === 'complete' && r.skippedReason === 'No code references found'
  ).length;
  const noChanges = results.filter(
    (r) =>
      r.status === 'complete' &&
      (r.prUrls?.length ?? 0) === 0 &&
      r.skippedReason !== 'No code references found'
  ).length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  return {
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    config: {
      concurrency: runtime.concurrency,
      maxPrs: runtime.maxPrs,
      dryRun,
    },
    input: {
      fetcherType,
      totalFetched: allFlags.length,
      skippedExisting: skipped,
      processed: results.length - skipped,
    },
    results: {
      prsCreated,
      noChanges,
      noCodeReferences,
      failed,
      skipped,
      remaining: remainingCount,
    },
    flags: results,
    logDir,
  };
}

function printSummary(summary: RunSummary, logger: Logger): void {
  const duration = new Date(summary.endTime).getTime() - new Date(summary.startTime).getTime();

  logger.log(`\n${'═'.repeat(60)}`);
  logger.log('                    bye-bye-flag Run Complete');
  logger.log(`${'═'.repeat(60)}`);
  logger.log(`Fetcher: ${summary.input.fetcherType} (found ${summary.input.totalFetched} stale flags)`);
  logger.log(`Duration: ${formatDuration(duration)}`);
  logger.log(`Processed: ${summary.input.processed} flags`);
  logger.log('');
  logger.log(`  ✓ ${summary.results.prsCreated} PRs created`);
  logger.log(`  ○ ${summary.results.noChanges} no changes needed`);
  logger.log(`  ○ ${summary.results.noCodeReferences} no code references`);
  logger.log(`  ✗ ${summary.results.failed} failed`);
  logger.log(`  ⊘ ${summary.results.skipped} skipped`);

  if (summary.results.remaining > 0) {
    logger.log(`  … ${summary.results.remaining} remaining (maxPrs limit)`);
  }

  const prsCreatedFlags = summary.flags.filter((f) => f.prUrls && f.prUrls.length > 0);
  if (prsCreatedFlags.length > 0) {
    logger.log('\nPRs created:');
    for (const flag of prsCreatedFlags) {
      for (const url of flag.prUrls!) {
        logger.log(`  • ${flag.key}: ${url}`);
      }
    }
  }

  const skippedFlagResults = summary.flags.filter((f) => f.status === 'skipped' && f.skippedReason);
  if (skippedFlagResults.length > 0) {
    logger.log('\nSkipped:');
    for (const flag of skippedFlagResults) {
      logger.log(`  • ${flag.key}: ${flag.skippedReason}`);
    }
  }

  const failedFlags = summary.flags.filter((f) => f.status === 'failed');
  if (failedFlags.length > 0) {
    logger.log('\nFailed:');
    for (const flag of failedFlags) {
      logger.log(`  • ${flag.key}: ${flag.error}`);
    }
  }

  // Show flags with no code references (safe to remove from feature flag system)
  // Group by creator so it's easy to notify flag owners
  const noCodeFlags = summary.flags.filter(
    (f) => f.status === 'complete' && f.skippedReason === 'No code references found'
  );
  if (noCodeFlags.length > 0) {
    logger.log('\nNo code references (safe to remove from feature flag system):');

    // Group by creator
    const byCreator = new Map<string, string[]>();
    for (const flag of noCodeFlags) {
      const creator = flag.createdBy || 'Unknown';
      const creatorFlags = byCreator.get(creator) || [];
      creatorFlags.push(flag.key);
      byCreator.set(creator, creatorFlags);
    }

    // Sort by creator name, with "Unknown" last
    const sortedCreators = [...byCreator.keys()].sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return a.localeCompare(b);
    });

    for (const creator of sortedCreators) {
      const creatorFlags = byCreator.get(creator)!;
      logger.log(`  ${creator}:`);
      for (const key of creatorFlags) {
        logger.log(`    • ${key}`);
      }
    }
  }

  logger.log(`\nLogs: ${summary.logDir}`);

  if (summary.results.remaining > 0) {
    logger.log(`\nTo continue processing remaining flags, run the command again.`);
  }

  logger.log('');
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
