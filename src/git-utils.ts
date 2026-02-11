/**
 * Shared git utility functions used by both the agent and the orchestrator.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { execa } from 'execa';
import type { ByeByeFlagConfig } from './agent/scaffold.ts';
import { getRepoBaseBranch } from './agent/scaffold.ts';
import type { Logger } from './types.ts';
import { consoleLogger } from './types.ts';

/**
 * Check if a flag exists in a single git repo using git grep on the configured base branch.
 * Searches for the flag key wrapped in quotes to avoid false positives like `my-flag-2`.
 */
export async function flagExistsInRepo(
  repoPath: string,
  flagKey: string,
  baseBranch: string
): Promise<boolean> {
  const escapedKey = flagKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `["'\`]${escapedKey}["'\`]`;

  const result = await execa('git', ['grep', '-lE', pattern, `origin/${baseBranch}`], {
    cwd: repoPath,
    reject: false,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Check if a flag exists anywhere in the codebase by searching each configured repo.
 * Searches on `origin/<baseBranch>` so the check reflects the latest remote code.
 */
export async function flagExistsInCodebase(
  workspacePath: string,
  flagKey: string,
  config: ByeByeFlagConfig
): Promise<boolean> {
  try {
    const entries = await fs.readdir(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const repoPath = path.join(workspacePath, entry.name);
      try {
        await fs.access(path.join(repoPath, '.git'));
        const baseBranch = getRepoBaseBranch(config, entry.name);
        if (await flagExistsInRepo(repoPath, flagKey, baseBranch)) {
          return true;
        }
      } catch {
        // Not a git repo or not configured, skip
      }
    }
    return false;
  } catch {
    // If something fails, assume the flag might exist and let the model check
    return true;
  }
}

/**
 * Fetch latest from origin for all configured repos (parallel).
 */
export async function fetchAllRepos(
  configContext: { reposDir: string; config: ByeByeFlagConfig },
  logger: Logger = consoleLogger
): Promise<void> {
  const { reposDir, config } = configContext;
  const repoNames = Object.keys(config.repos);

  await Promise.all(
    repoNames.map(async (repoName) => {
      const repoPath = path.join(reposDir, repoName);
      logger.log(`  Fetching ${repoName}...`);
      try {
        await execa('git', ['fetch', 'origin'], { cwd: repoPath });
      } catch {
        logger.error(`  Warning: Failed to fetch ${repoName}`);
      }
    })
  );
}
