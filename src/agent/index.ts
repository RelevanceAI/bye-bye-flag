import * as path from 'path';
import * as fs from 'fs/promises';
import { execa } from 'execa';
import { CONFIG } from '../config.ts';
import type { RemovalRequest, RemovalResult } from '../types.ts';
import {
  setupMultiRepoWorktrees,
  cleanupMultiRepoWorktrees,
  readConfig,
  type ScaffoldResult,
} from './scaffold.ts';
import { generatePrompt, readContextFiles } from './prompt.ts';
import { invokeClaudeCode } from './invoke.ts';
import { commitAndPushMultiRepo, hasChanges, showDiff } from './git.ts';

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
 * Gets the default branch name for a repo
 */
async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
    });
    return stdout.replace('refs/remotes/origin/', '').trim();
  } catch {
    try {
      await execa('git', ['rev-parse', '--verify', 'origin/main'], { cwd: repoPath });
      return 'main';
    } catch {
      return 'master';
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

  // Check claude CLI is installed
  try {
    await execa('claude', ['--version']);
  } catch {
    errors.push('claude CLI is not installed. Install with: npm install -g @anthropic-ai/claude-code');
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

  // Check repos directory exists
  try {
    const stat = await fs.stat(request.reposDir);
    if (!stat.isDirectory()) {
      errors.push(`--repos-dir is not a directory: ${request.reposDir}`);
    }
  } catch {
    errors.push(`--repos-dir does not exist: ${request.reposDir}`);
  }

  return errors;
}

/**
 * Main entry point for the removal agent
 * Operates on a directory containing bye-bye-flag.json and one or more git repos
 */
export async function removeFlag(request: RemovalRequest): Promise<RemovalResult> {
  const { flagKey, keepBranch, reposDir, dryRun, keepWorktree } = request;
  const branchName = `${CONFIG.branchPrefix}${flagKey}`;

  // Check prerequisites first
  console.log('Checking prerequisites...');
  const errors = await checkPrerequisites(request);
  if (errors.length > 0) {
    console.error('\nPrerequisite check failed:');
    errors.forEach((e) => console.error(`  - ${e}`));
    return {
      status: 'failed',
      error: `Prerequisites not met: ${errors.join('; ')}`,
    };
  }
  console.log('Prerequisites OK\n');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Removing flag: ${flagKey} (keep: ${keepBranch})`);
  console.log(`Repos directory: ${reposDir}`);
  console.log(`${'='.repeat(60)}\n`);

  // Fetch latest from all repos before checking for flag
  console.log('Fetching latest from origin...');
  await fetchAllRepos(reposDir);

  // Check if flag exists in any repo BEFORE scaffolding (saves time if flag not found)
  console.log(`\nChecking if flag "${flagKey}" exists in codebase...`);
  const flagExists = await flagExistsInCodebase(reposDir, flagKey);
  if (!flagExists) {
    console.log(`Flag "${flagKey}" not found in any repository. Safe to remove from feature flag system.`);
    return {
      status: 'success',
      summary: `Flag "${flagKey}" was not found anywhere in the codebase. It can be safely removed from the feature flag system.`,
      filesChanged: [],
      branchName,
    };
  }
  console.log(`Flag found. Setting up worktrees...`);

  let scaffoldResult: ScaffoldResult | null = null;

  try {
    // Setup worktrees for all repos
    scaffoldResult = await setupMultiRepoWorktrees({
      reposDir,
      branchName,
    });

    if (scaffoldResult.repos.length === 0) {
      return {
        status: 'failed',
        error: 'No git repositories found in the specified directory',
        branchName,
      };
    }

    console.log(`\nFound ${scaffoldResult.repos.length} repos:`);
    scaffoldResult.repos.forEach((r) => console.log(`  - ${r.name}`));

    console.log(`\nLaunching Claude Code to remove the flag...`);

    // Read context from workspace (copied from reposDir)
    const globalContext = await readContextFiles(scaffoldResult.workspacePath);

    const prompt = await generatePrompt({
      flagKey,
      keepBranch,
      globalContext,
    });

    // Run Claude Code at the workspace root (can see all repos)
    const agentOutput = await invokeClaudeCode(
      scaffoldResult.workspacePath,
      branchName,
      prompt,
      reposDir
    );

    if (agentOutput.status === 'refused') {
      console.log(`\nAgent refused: ${agentOutput.summary}`);
      return {
        status: 'refused',
        refusalReason: agentOutput.summary,
        branchName,
      };
    }

    if (dryRun) {
      console.log('\n--- DRY RUN MODE ---');
      console.log('Agent completed successfully.');
      console.log(`Summary: ${agentOutput.summary}`);
      console.log(`Files changed: ${agentOutput.filesChanged.join(', ')}`);

      // Show which repos have changes
      console.log('\nRepos with changes:');
      for (const repo of scaffoldResult.repos) {
        const changed = await hasChanges(repo.worktreePath);
        console.log(`  ${repo.name}: ${changed ? 'HAS CHANGES' : 'no changes'}`);
        if (changed) {
          const diff = await showDiff(repo.worktreePath);
          console.log(`\n--- ${repo.name} DIFF ---`);
          console.log(diff);
          console.log(`--- END ${repo.name} DIFF ---\n`);
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
    console.log('\nCommitting and creating PRs...');
    const repoResults = await commitAndPushMultiRepo(
      scaffoldResult.repos,
      branchName,
      flagKey,
      keepBranch,
      agentOutput
    );

    const successCount = repoResults.filter((r) => r.status === 'success').length;
    const noChangesCount = repoResults.filter((r) => r.status === 'no-changes').length;

    console.log(`\nResults: ${successCount} PRs created, ${noChangesCount} repos unchanged`);

    return {
      status: 'success',
      branchName,
      summary: agentOutput.summary,
      filesChanged: agentOutput.filesChanged,
      repoResults,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\nError removing flag: ${errorMessage}`);

    return {
      status: 'failed',
      error: errorMessage,
      branchName,
    };
  } finally {
    if (scaffoldResult) {
      if (keepWorktree) {
        console.log(`\nWorktree preserved at: ${scaffoldResult.workspacePath}`);
        console.log('You can inspect with: git diff, git status, or your favorite diff tool');
        console.log('To cleanup manually: rm -rf ' + scaffoldResult.workspacePath);
      } else {
        await cleanupMultiRepoWorktrees(scaffoldResult);
      }
    }
  }
}
