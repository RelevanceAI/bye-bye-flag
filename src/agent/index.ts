import * as path from 'path';
import * as fs from 'fs/promises';
import { execa } from 'execa';
import { CONFIG } from '../config.ts';
import {
  consoleLogger,
  type Logger,
  type RemovalRequest,
  type RemovalResult,
  type RepoResult,
} from '../types.ts';
import { setupMultiRepoWorktrees, cleanupMultiRepoWorktrees, type ScaffoldResult } from './scaffold.ts';
import { generatePrompt, readContextFiles } from './prompt.ts';
import { commitAndPushMultiRepo, findExistingPR, hasChanges, stageAndDiff } from './git.ts';
import { resolveAgentRuntime, type AgentRuntime } from './adapters.ts';
import type { ConfigContext } from '../config-context.ts';
import { flagExistsInCodebase, fetchAllRepos } from '../git-utils.ts';

export interface RemoveFlagOptions extends RemovalRequest {
  configContext: ConfigContext;
  flagCreatedBy?: string;
  logger?: Logger; // Optional logger (defaults to console)
  // Internal: used by orchestrator to skip redundant preflight checks.
  skipFetch?: boolean;
}

/**
 * Check prerequisites before running
 */
async function checkPrerequisites(
  configContext: ConfigContext,
  dryRun: boolean | undefined,
  agentRuntime: AgentRuntime
): Promise<string[]> {
  const errors: string[] = [];
  const { reposDir } = configContext;

  // Check git is installed
  try {
    await execa('git', ['--version']);
  } catch {
    errors.push('git is not installed or not in PATH');
  }

  // Check repos directory exists
  try {
    const stat = await fs.stat(reposDir);
    if (!stat.isDirectory()) {
      errors.push(`Config directory is not a directory: ${reposDir}`);
    }
  } catch {
    errors.push(`Config directory does not exist: ${reposDir}`);
  }

  if (agentRuntime.kind === 'claude') {
    try {
      await execa(agentRuntime.prerequisiteCommand, agentRuntime.prerequisiteArgs);
    } catch {
      errors.push('claude CLI is not installed. Install with: npm install -g @anthropic-ai/claude-code');
    }
  } else if (agentRuntime.kind === 'codex') {
    try {
      await execa(agentRuntime.prerequisiteCommand, agentRuntime.prerequisiteArgs);
    } catch {
      errors.push('codex CLI is not installed. Install Codex CLI first.');
    }
  } else {
    try {
      await execa(agentRuntime.prerequisiteCommand, agentRuntime.prerequisiteArgs);
    } catch {
      errors.push(
        `Configured agent CLI "${agentRuntime.prerequisiteCommand}" is not installed or not in PATH.`
      );
    }
  }

  // Check gh CLI only if we'll create PRs (not dry-run)
  if (!dryRun) {
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
  const {
    flagKey,
    keepBranch,
    dryRun,
    keepWorktree,
    configContext,
    flagCreatedBy,
    logger = consoleLogger,
  } = options;
  const { reposDir, configPath, config } = configContext;
  const branchName = `${CONFIG.branchPrefix}${flagKey}`;
  const agentRuntime = resolveAgentRuntime(config);
  let resolvedAgentKind = agentRuntime.kind;
  let agentSessionId: string | undefined;
  let agentResumeCommand: string | undefined;

  // Check prerequisites first
  logger.log('Checking prerequisites...');
  const errors = await checkPrerequisites(configContext, dryRun, agentRuntime);
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

  // Fetch latest from all repos before checking for flag.
  // When called from orchestrator, skipFetch=true and these checks are already done at orchestrator level.
  if (!options.skipFetch) {
    logger.log('Fetching latest from origin...');
    await fetchAllRepos(configContext, logger);

    // In standalone mode (remove command), protect against overwriting an existing open/declined PR.
    // The orchestrator performs this check in batch before invoking the agent.
    if (!dryRun) {
      logger.log('Checking for existing PRs...');
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
    const flagExists = await flagExistsInCodebase(reposDir, flagKey, config);
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
      configPath,
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

    // Read context from workspace (copied from reposDir)
    const globalContext = await readContextFiles(scaffoldResult.workspacePath);

    const prompt = await generatePrompt({
      flagKey,
      keepBranch,
      globalContext,
    });

    logger.log(`Launching agent (${resolvedAgentKind}) to remove the flag...`);

    const invocation = await agentRuntime.invoke({
      workspacePath: scaffoldResult.workspacePath,
      branchName,
      prompt,
      reposDir,
      configPath,
      logger,
    });
    resolvedAgentKind = invocation.kind;
    agentSessionId = invocation.sessionId;
    agentResumeCommand = invocation.resumeCommand;
    const agentOutput = invocation.output;

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
          const diff = await stageAndDiff(repo.worktreePath);
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
      resolvedAgentKind,
      agentSessionId,
      agentResumeCommand,
      flagCreatedBy,
      logger
    );

    const successCount = repoResults.filter((r) => r.status === 'success').length;
    const noChangesCount = repoResults.filter((r) => r.status === 'no-changes').length;
    const failedResults = repoResults.filter((r) => r.status === 'failed');

    logger.log(
      `Results: ${successCount} PRs created, ${noChangesCount} repos unchanged, ${failedResults.length} failed`
    );

    if (failedResults.length > 0) {
      logger.log('Failed repos:');
      for (const r of failedResults) {
        logger.log(`  - ${r.repoName}: ${r.error ?? 'unknown error'}`);
      }

      // If nothing was created successfully, treat the whole run as failed so the orchestrator
      // doesn't misreport it as "no changes needed".
      if (successCount === 0) {
        const failedRepos = failedResults.map((r) => r.repoName).join(', ');
        return {
          status: 'failed',
          error: `Failed to create PRs in ${failedResults.length} repo(s): ${failedRepos}`,
          branchName,
          summary: agentOutput.summary,
          filesChanged: agentOutput.filesChanged,
          repoResults,
        };
      }
    }

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
