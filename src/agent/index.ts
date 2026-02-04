import * as path from 'path';
import * as fs from 'fs/promises';
import { execa } from 'execa';
import { CONFIG } from '../config.ts';
import { consoleLogger, type AgentKind, type Logger, type RemovalRequest, type RemovalResult, type RepoResult } from '../types.ts';
import {
  setupMultiRepoWorktrees,
  cleanupMultiRepoWorktrees,
  readConfig,
  getDefaultBranch,
  type ScaffoldResult,
} from './scaffold.ts';
import { generatePrompt, readContextFiles } from './prompt.ts';
import { invokeClaudeCode } from './invoke.ts';
import { invokeCodexCli } from './invoke-codex.ts';
import { commitAndPushMultiRepo, findExistingPR, hasChanges, showDiff } from './git.ts';
import { getSessionId } from './invoke.ts';

export interface RemoveFlagOptions extends RemovalRequest {
  logger?: Logger; // Optional logger (defaults to console)
  // Internal: used by orchestrator to skip redundant preflight checks.
  skipFetch?: boolean;
}

/**
 * Fetch latest from origin for all configured repos
 */
async function fetchAllRepos(reposDir: string): Promise<void> {
  const config = await readConfig(reposDir);
  const repoNames = Object.keys(config.repos);

  for (const repoName of repoNames) {
    const repoPath = path.join(reposDir, repoName);
    console.log(`  Fetching ${repoName}...`);
    try {
      await execa('git', ['fetch', 'origin'], { cwd: repoPath, stdio: 'inherit' });
    } catch (error) {
      console.warn(`  Warning: Failed to fetch ${repoName}`);
    }
  }
}

/**
 * Check if a flag exists in a single git repo using git grep on origin's default branch
 */
async function flagExistsInRepo(repoPath: string, pattern: string): Promise<boolean> {
  const defaultBranch = await getDefaultBranch(repoPath);
  // Search on origin/defaultBranch to check the latest remote code
  const result = await execa('git', ['grep', '-lE', pattern, `origin/${defaultBranch}`], {
    cwd: repoPath,
    reject: false,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Check if a flag exists in the codebase using git grep (respects .gitignore)
 * Searches each repo subdirectory in the workspace
 */
async function flagExistsInCodebase(workspacePath: string, flagKey: string): Promise<boolean> {
  try {
    // Escape regex special characters in the flag key
    const escapedKey = flagKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Search for flag key in quotes (single, double, or backtick) to avoid false positives like my-flag-2
    const pattern = `["'\`]${escapedKey}["'\`]`;

    // Search each subdirectory that's a git repo
    const entries = await fs.readdir(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const repoPath = path.join(workspacePath, entry.name);
      try {
        await fs.access(path.join(repoPath, '.git'));
        if (await flagExistsInRepo(repoPath, pattern)) {
          return true;
        }
      } catch {
        // Not a git repo, skip
      }
    }
    return false;
  } catch {
    // If something fails, assume the flag might exist and let the model check
    return true;
  }
}

/**
 * Check prerequisites before running
 */
async function checkPrerequisites(request: RemovalRequest): Promise<string[]> {
  const errors: string[] = [];

  // Check git is installed
  try {
    await execa('git', ['--version']);
  } catch {
    errors.push('git is not installed or not in PATH');
  }

  // Check repos directory exists
  try {
    const stat = await fs.stat(request.reposDir);
    if (!stat.isDirectory()) {
      errors.push(`--repos-dir is not a directory: ${request.reposDir}`);
    }
  } catch {
    errors.push(`--repos-dir does not exist: ${request.reposDir}`);
  }

  // Read config to determine which agent CLI is required
  let agentKind: AgentKind | null = null;
  if (errors.length === 0) {
    try {
      const config = await readConfig(request.reposDir);
      agentKind = (config.agent?.type ?? 'claude') as AgentKind;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
    }
  }

  if (agentKind === 'claude') {
    try {
      await execa('claude', ['--version']);
    } catch {
      errors.push('claude CLI is not installed. Install with: npm install -g @anthropic-ai/claude-code');
    }
  } else if (agentKind === 'codex') {
    try {
      await execa('codex', ['--version']);
    } catch {
      errors.push('codex CLI is not installed. Install Codex CLI first.');
    }
  }

  // Check gh CLI only if we'll create PRs (not dry-run)
  if (!request.dryRun) {
    try {
      await execa('gh', ['--version']);
      // Check if authenticated
      const { exitCode } = await execa('gh', ['auth', 'status'], { reject: false });
      if (exitCode !== 0) {
        errors.push('GitHub CLI is not authenticated. Run: gh auth login');
      }
    } catch {
      errors.push('gh CLI is not installed. Install from: https://cli.github.com/');
    }
  }

  return errors;
}

/**
 * Main entry point for the removal agent
 * Operates on a directory containing bye-bye-flag-config.json and one or more git repos
 */
export async function removeFlag(options: RemoveFlagOptions): Promise<RemovalResult> {
  const { flagKey, keepBranch, reposDir, dryRun, keepWorktree, logger = consoleLogger } = options;
  const branchName = `${CONFIG.branchPrefix}${flagKey}`;
  let agentKind: AgentKind = 'claude';
  let agentSessionId: string | undefined;

  // Check prerequisites first
  logger.log('Checking prerequisites...');
  const errors = await checkPrerequisites(options);
  if (errors.length > 0) {
    logger.error('Prerequisite check failed:');
    errors.forEach((e) => logger.error(`  - ${e}`));
    return {
      status: 'failed',
      error: `Prerequisites not met: ${errors.join('; ')}`,
    };
  }
  logger.log('Prerequisites OK');

  logger.log(`${'='.repeat(60)}`);
  logger.log(`Removing flag: ${flagKey} (keep: ${keepBranch})`);
  logger.log(`Repos directory: ${reposDir}`);
  logger.log(`${'='.repeat(60)}`);

  // Fetch latest from all repos before checking for flag
  // TODO: Revisit - should we always skip these checks? Depends on whether we need standalone agent usage
  // When called from orchestrator, skipFetch=true and these checks are already done at orchestrator level
  if (!options.skipFetch) {
    logger.log('Fetching latest from origin...');
    await fetchAllRepos(reposDir);

    // In standalone mode (remove command), protect against overwriting an existing open/declined PR.
    // The orchestrator performs this check in batch before invoking the agent.
    if (!dryRun) {
      logger.log('Checking for existing PRs...');
      const config = await readConfig(reposDir);
      const repoNames = Object.keys(config.repos);

      for (const repoName of repoNames) {
        const repoPath = path.join(reposDir, repoName);
        const existing = await findExistingPR(repoPath, flagKey);
        if (!existing) continue;

        if (existing.declined) {
          return {
            status: 'refused',
            refusalReason: `Declined PR exists: ${existing.url}`,
            branchName,
          };
        }
        if (existing.state === 'OPEN') {
          return {
            status: 'refused',
            refusalReason: `Open PR exists: ${existing.url}`,
            branchName,
          };
        }
      }
    }

    // Check if flag exists in any repo BEFORE scaffolding (saves time if flag not found)
    logger.log(`Checking if flag "${flagKey}" exists in codebase...`);
    const flagExists = await flagExistsInCodebase(reposDir, flagKey);
    if (!flagExists) {
      logger.log(`Flag "${flagKey}" not found in any repository. Safe to remove from feature flag system.`);
      return {
        status: 'success',
        summary: `Flag "${flagKey}" was not found anywhere in the codebase. It can be safely removed from the feature flag system.`,
        filesChanged: [],
        branchName,
      };
    }
  }

  logger.log(`Setting up worktrees...`);

  let scaffoldResult: ScaffoldResult | null = null;
  let repoResults: RepoResult[] | undefined = undefined;

  try {
    // Setup worktrees for all repos
    scaffoldResult = await setupMultiRepoWorktrees({
      reposDir,
      branchName,
      deleteRemoteBranch: !dryRun,
      logger,
    });

    if (scaffoldResult.repos.length === 0) {
      return {
        status: 'failed',
        error: 'No git repositories found in the specified directory',
        branchName,
      };
    }

    logger.log(`Found ${scaffoldResult.repos.length} repos:`);
    scaffoldResult.repos.forEach((r) => logger.log(`  - ${r.name}`));

    const config = await readConfig(reposDir);
    agentKind = (config.agent?.type ?? 'claude') as AgentKind;
    const agentArgs = config.agent?.args ?? [];

    // Read context from workspace (copied from reposDir)
    const globalContext = await readContextFiles(scaffoldResult.workspacePath);

    const prompt = await generatePrompt({
      flagKey,
      keepBranch,
      globalContext,
    });

    logger.log(`Launching agent (${agentKind}) to remove the flag...`);

    let agentOutput: Awaited<ReturnType<typeof invokeClaudeCode>>;

    if (agentKind === 'claude') {
      // Generate session ID for this run (used for resume capability)
      agentSessionId = getSessionId(branchName);
      // Run Claude Code at the workspace root (can see all repos)
      agentOutput = await invokeClaudeCode(
        scaffoldResult.workspacePath,
        branchName,
        prompt,
        reposDir,
        undefined,
        agentSessionId,
        logger,
        agentArgs
      );
    } else if (agentKind === 'codex') {
      const codexResult = await invokeCodexCli(scaffoldResult.workspacePath, prompt, reposDir, undefined, logger, agentArgs);
      agentSessionId = codexResult.sessionId;
      agentOutput = codexResult.output;
    } else {
      throw new Error(`Unknown agent type: ${agentKind}`);
    }

    if (agentOutput.status === 'refused') {
      logger.log(`Agent refused: ${agentOutput.summary}`);
      return {
        status: 'refused',
        refusalReason: agentOutput.summary,
        branchName,
      };
    }

    if (dryRun) {
      logger.log('--- DRY RUN MODE ---');
      logger.log('Agent completed successfully.');
      logger.log(`Summary: ${agentOutput.summary}`);
      logger.log(`Files changed: ${agentOutput.filesChanged.join(', ')}`);

      // Show which repos have changes
      logger.log('Repos with changes:');
      for (const repo of scaffoldResult.repos) {
        const changed = await hasChanges(repo.worktreePath);
        logger.log(`  ${repo.name}: ${changed ? 'HAS CHANGES' : 'no changes'}`);
        if (changed) {
          const diff = await showDiff(repo.worktreePath);
          logger.log(`--- ${repo.name} DIFF ---`);
          logger.log(diff);
          logger.log(`--- END ${repo.name} DIFF ---`);
        }
      }

      return {
        status: 'success',
        branchName,
        summary: agentOutput.summary,
        filesChanged: agentOutput.filesChanged,
      };
    }

    // Commit and create PRs for each repo with changes
    logger.log('Committing and creating PRs...');
    repoResults = await commitAndPushMultiRepo(
      scaffoldResult.repos,
      branchName,
      flagKey,
      keepBranch,
      agentOutput,
      agentKind,
      agentSessionId,
      scaffoldResult.workspacePath
    );

    const successCount = repoResults.filter((r) => r.status === 'success').length;
    const noChangesCount = repoResults.filter((r) => r.status === 'no-changes').length;

    logger.log(`Results: ${successCount} PRs created, ${noChangesCount} repos unchanged`);

    return {
      status: 'success',
      branchName,
      summary: agentOutput.summary,
      filesChanged: agentOutput.filesChanged,
      repoResults,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error removing flag: ${errorMessage}`);

    return {
      status: 'failed',
      error: errorMessage,
      branchName,
    };
  } finally {
    if (scaffoldResult) {
      // Determine if we should keep the worktree:
      // - Always keep if --keep-worktree flag is set
      // - Keep after successful PR creation (for resume capability)
      // - Clean up on dry-run (unless --keep-worktree)
      // - Clean up on error (worktree might be in bad state)
      // Only consider PRs created if repoResults exists and has at least one success
      const prCreated = !dryRun && repoResults && repoResults.some((r) => r.status === 'success');
      const shouldKeep = keepWorktree || prCreated;

      if (shouldKeep) {
        logger.log(`Worktree preserved at: ${scaffoldResult.workspacePath}`);
        logger.log('The worktree will be automatically cleaned up when the PR is merged or closed.');
        logger.log('To resume, see the PR description for the resume command.');
        logger.log('To cleanup manually: rm -rf ' + scaffoldResult.workspacePath);
      } else {
        await cleanupMultiRepoWorktrees(scaffoldResult);
      }
    }
  }
}
