import { execa } from 'execa';
import * as path from 'path';
import * as fs from 'fs/promises';
import { CONFIG } from '../config.ts';

export interface ScaffoldOptions {
  reposDir: string; // Directory containing bye-bye-flag.json and repo subdirectories
  branchName: string;
}

export interface ScaffoldResult {
  workspacePath: string; // Root path containing all worktrees
  repos: Array<{
    name: string;
    originalPath: string;
    worktreePath: string;
  }>;
}

/**
 * Creates worktrees for all git repos configured in bye-bye-flag.json
 * Returns a workspace root containing all worktrees
 */
export async function setupMultiRepoWorktrees(
  options: ScaffoldOptions
): Promise<ScaffoldResult> {
  const { reposDir, branchName } = options;
  const workspacePath = path.join(CONFIG.worktreeBasePath, branchName.replace(/\//g, '-'));

  // Ensure workspace path exists
  await fs.mkdir(workspacePath, { recursive: true });

  // Read config and validate repos
  const config = await readConfig(reposDir);
  const configuredRepos = Object.keys(config.repos);

  if (configuredRepos.length === 0) {
    throw new Error('No repos configured in bye-bye-flag.json');
  }

  // Validate each configured repo exists and is a git repo
  for (const repoName of configuredRepos) {
    const repoPath = path.join(reposDir, repoName);
    try {
      const stat = await fs.stat(repoPath);
      if (!stat.isDirectory()) {
        throw new Error(`Configured repo "${repoName}" is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Configured repo "${repoName}" does not exist in ${reposDir}`);
      }
      throw error;
    }

    try {
      await fs.access(path.join(repoPath, '.git'));
    } catch {
      throw new Error(`Configured repo "${repoName}" is not a git repository (no .git directory)`);
    }
  }

  const repos: ScaffoldResult['repos'] = [];

  for (const repoName of configuredRepos) {
    const repoPath = path.join(reposDir, repoName);
    const worktreePath = path.join(workspacePath, repoName);

    // Clean up existing worktree if present
    try {
      await fs.access(worktreePath);
      console.log(`Cleaning up existing worktree at ${worktreePath}...`);
      await execa('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
    } catch {
      // Doesn't exist, fine
    }

    // Delete existing branch if it exists (local and remote) so we start fresh
    // Using reject: false so these won't throw even if branch doesn't exist
    await execa('git', ['branch', '-D', branchName], { cwd: repoPath, reject: false });
    await execa('git', ['push', 'origin', '--delete', branchName], { cwd: repoPath, reject: false });

    // Get default branch and fetch latest from remote
    const defaultBranch = await getDefaultBranch(repoPath);
    console.log(`Fetching latest from origin for ${repoName}...`);
    await execa('git', ['fetch', 'origin', defaultBranch], { cwd: repoPath, stdio: 'inherit' });

    // Create worktree with the new branch based on origin's default branch
    console.log(`Creating worktree for ${repoName} on branch ${branchName}...`);
    await execa('git', ['worktree', 'add', '-b', branchName, worktreePath, `origin/${defaultBranch}`], { cwd: repoPath });

    // Setup node and run setup commands
    await runSetupCommands(worktreePath, reposDir);

    repos.push({
      name: repoName,
      originalPath: repoPath,
      worktreePath,
    });
  }

  // Copy any .md files from reposDir to workspace root (for context)
  const dirEntries = await fs.readdir(reposDir, { withFileTypes: true });
  const mdFiles = dirEntries.filter((e) => e.isFile() && e.name.endsWith('.md'));
  for (const mdFile of mdFiles) {
    await fs.copyFile(path.join(reposDir, mdFile.name), path.join(workspacePath, mdFile.name));
  }

  console.log(`\nWorkspace created at ${workspacePath} with ${repos.length} repos`);

  return { workspacePath, repos };
}

/**
 * Removes a single worktree
 */
async function cleanupWorktree(repoPath: string, worktreePath: string): Promise<void> {
  console.log(`Cleaning up worktree at ${worktreePath}...`);
  try {
    await execa('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoPath,
    });
  } catch (error) {
    console.warn(`Failed to remove worktree: ${error}`);
  }
}

/**
 * Cleans up all worktrees in a workspace
 */
export async function cleanupMultiRepoWorktrees(result: ScaffoldResult): Promise<void> {
  for (const repo of result.repos) {
    await cleanupWorktree(repo.originalPath, repo.worktreePath);
  }
  // Remove the workspace directory
  try {
    await fs.rm(result.workspacePath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Gets the default branch name (main or master)
 */
async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
    });
    return stdout.replace('refs/remotes/origin/', '').trim();
  } catch {
    // Fallback: check if main or master exists
    try {
      await execa('git', ['rev-parse', '--verify', 'main'], { cwd: repoPath });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

interface RepoEntry {
  shellInit?: string; // Override shell init for this repo
  setup: string[];
}

interface ReposConfig {
  shellInit?: string; // Default command to run before each shell command
  repos: Record<string, RepoEntry>;
}

let cachedConfig: ReposConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Reads bye-bye-flag.json from the repos root directory
 * Throws if config file is missing
 */
export async function readConfig(reposDir: string): Promise<ReposConfig> {
  const configPath = path.join(reposDir, 'bye-bye-flag.json');

  if (cachedConfig && cachedConfigPath === configPath) {
    return cachedConfig;
  }

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    cachedConfig = JSON.parse(content);
    cachedConfigPath = configPath;
    return cachedConfig!;
  } catch {
    throw new Error(`Missing required config file: ${configPath}`);
  }
}

/**
 * Gets the shellInit command for a specific repo (or default)
 */
export async function getShellInit(reposDir: string, repoName?: string): Promise<string | undefined> {
  const config = await readConfig(reposDir);
  if (repoName && config.repos[repoName]?.shellInit !== undefined) {
    return config.repos[repoName].shellInit;
  }
  return config.shellInit;
}

/**
 * Runs setup commands for a repo
 * Requires bye-bye-flag.json with an entry for this repo
 */
async function runSetupCommands(
  worktreePath: string,
  reposDir: string
): Promise<void> {
  const repoName = path.basename(worktreePath);
  const config = await readConfig(reposDir);

  const repoConfig = config.repos[repoName];
  if (!repoConfig) {
    throw new Error(`No config entry for repo "${repoName}" in bye-bye-flag.json`);
  }

  // Per-repo shellInit takes precedence over default
  const shellInitCmd = repoConfig.shellInit ?? config.shellInit;
  const shellInit = shellInitCmd ? `${shellInitCmd} && ` : '';

  // Run each setup command
  for (const cmd of repoConfig.setup) {
    console.log(`  Running: ${cmd}`);
    try {
      await execa('bash', ['-c', `${shellInit}${cmd}`], {
        cwd: worktreePath,
        stdio: 'inherit',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Setup command "${cmd}" failed in ${repoName}: ${message}`);
    }
  }
}
