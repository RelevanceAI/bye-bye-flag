import { execa } from 'execa';
import * as path from 'path';
import * as fs from 'fs/promises';
import { z } from 'zod';
import { CONFIG } from '../config.ts';
import { consoleLogger, type Logger } from '../types.ts';

export interface ScaffoldOptions {
  reposDir: string; // Directory containing bye-bye-flag-config.json and repo subdirectories
  branchName: string;
  /**
   * If true, delete the remote branch on origin before recreating it locally.
   * Useful for ensuring a "fresh" branch for PR creation, but should be disabled
   * in dry-run mode to avoid network/destructive operations.
   */
  deleteRemoteBranch?: boolean;
  logger?: Logger; // Optional logger (defaults to console)
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
 * Creates worktrees for all git repos configured in bye-bye-flag-config.json
 * Returns a workspace root containing all worktrees
 */
export async function setupMultiRepoWorktrees(
  options: ScaffoldOptions
): Promise<ScaffoldResult> {
  const { reposDir, branchName, deleteRemoteBranch = true, logger = consoleLogger } = options;
  const workspacePath = path.join(CONFIG.worktreeBasePath, branchName.replace(/\//g, '-'));

  // Ensure workspace path exists
  await fs.mkdir(workspacePath, { recursive: true });

  // Read config and validate repos
  const config = await readConfig(reposDir);
  const configuredRepos = Object.keys(config.repos);

  if (configuredRepos.length === 0) {
    throw new Error('No repos configured in bye-bye-flag-config.json');
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

  // Setup all repos in parallel for faster initialization
  const repoSetupPromises = configuredRepos.map(async (repoName) => {
    const repoPath = path.join(reposDir, repoName);
    const worktreePath = path.join(workspacePath, repoName);

    // Clean up existing worktree if present
    try {
      await fs.access(worktreePath);
      logger.log(`[${repoName}] Cleaning up existing worktree...`);
      await execa('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
    } catch {
      // Doesn't exist, fine
    }

    // Delete existing branch if it exists (local and remote) so we start fresh
    // Using reject: false so these won't throw even if branch doesn't exist
    await execa('git', ['branch', '-D', branchName], { cwd: repoPath, reject: false });
    if (deleteRemoteBranch) {
      await execa('git', ['push', 'origin', '--delete', branchName], { cwd: repoPath, reject: false });
    }

    // Get default branch (already fetched in removeFlag before scaffolding)
    const defaultBranch = await getDefaultBranch(repoPath);

    // Create worktree with the new branch based on origin's default branch
    logger.log(`[${repoName}] Creating worktree on branch ${branchName}...`);
    await execa('git', ['worktree', 'add', '-b', branchName, worktreePath, `origin/${defaultBranch}`], { cwd: repoPath });

    // Setup node and run setup commands
    logger.log(`[${repoName}] Running setup commands...`);
    await runSetupCommands(worktreePath, reposDir, logger);
    logger.log(`[${repoName}] Setup complete`);

    return {
      name: repoName,
      originalPath: repoPath,
      worktreePath,
    };
  });

  const repos = await Promise.all(repoSetupPromises);

  // Copy any .md files from reposDir to workspace root (for context)
  const dirEntries = await fs.readdir(reposDir, { withFileTypes: true });
  const mdFiles = dirEntries.filter((e) => e.isFile() && e.name.endsWith('.md'));
  for (const mdFile of mdFiles) {
    await fs.copyFile(path.join(reposDir, mdFile.name), path.join(workspacePath, mdFile.name));
  }

  logger.log(`Workspace created at ${workspacePath} with ${repos.length} repos`);

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
export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
    });
    return stdout.replace('refs/remotes/origin/', '').trim();
  } catch {
    // Fallback: check if origin/main or origin/master exists
    try {
      await execa('git', ['rev-parse', '--verify', 'origin/main'], { cwd: repoPath });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

const RepoEntrySchema = z
  .object({
    shellInit: z.string().optional(), // Override shell init for this repo
    mainSetup: z.array(z.string()).optional(), // Setup commands for main repo (run once by orchestrator)
    setup: z.array(z.string()), // Setup commands for worktrees (run per flag)
  })
  .strict();

const OrchestratorSettingsSchema = z
  .object({
    concurrency: z.number().int().positive().optional(),
    maxPrs: z.number().int().nonnegative().optional(),
    logDir: z.string().optional(),
  })
  .strict();

const FetcherConfigSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('posthog'),
      staleDays: z.number().int().positive().optional(),
      host: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('manual') }).strict(),
]);

const AgentConfigSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('claude'),
      /**
       * Extra CLI args appended to the invocation (for example: model selection).
       * Do not include the prompt/session flags; those are managed by bye-bye-flag.
       */
      args: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('codex'),
      /**
       * Extra CLI args appended to the invocation (for example: model/profile selection).
       * Do not include the prompt/session flags; those are managed by bye-bye-flag.
       */
      args: z.array(z.string()).optional(),
    })
    .strict(),
]);

const ByeByeFlagConfigSchema = z
  .object({
    fetcher: FetcherConfigSchema.optional(),
    agent: AgentConfigSchema.optional(),
    orchestrator: OrchestratorSettingsSchema.optional(),
    shellInit: z.string().optional(), // Default command to run before each shell command
    repos: z.record(RepoEntrySchema),
  })
  .strict();

export type ByeByeFlagConfig = z.infer<typeof ByeByeFlagConfigSchema>;

let cachedConfig: ByeByeFlagConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Reads bye-bye-flag-config.json from the repos root directory
 * Throws if config file is missing
 */
const CONFIG_FILENAME = 'bye-bye-flag-config.json';

export async function readConfig(reposDir: string): Promise<ByeByeFlagConfig> {
  const preferredPath = path.join(reposDir, CONFIG_FILENAME);

  if (cachedConfig && cachedConfigPath === preferredPath) {
    return cachedConfig;
  }

  let content: string;

  try {
    content = await fs.readFile(preferredPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read config file: ${preferredPath}\n${message}`);
    }
    throw new Error(`Missing required config file: ${preferredPath}`);
  }

  try {
    const parsed = ByeByeFlagConfigSchema.parse(JSON.parse(content));
    cachedConfig = parsed;
    cachedConfigPath = preferredPath;
    return cachedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid config file: ${preferredPath}\n${issues}`);
    }
    throw error;
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
 * Requires bye-bye-flag-config.json with an entry for this repo
 * Supports ${MAIN_REPO} substitution to reference the main repo path
 */
async function runSetupCommands(
  worktreePath: string,
  reposDir: string,
  logger: Logger
): Promise<void> {
  const repoName = path.basename(worktreePath);
  const config = await readConfig(reposDir);
  // Use absolute path so it works from worktree location
  const mainRepoPath = path.resolve(reposDir, repoName);

  const repoConfig = config.repos[repoName];
  if (!repoConfig) {
    throw new Error(`No config entry for repo "${repoName}" in bye-bye-flag-config.json`);
  }

  // Per-repo shellInit takes precedence over default
  const shellInitCmd = repoConfig.shellInit ?? config.shellInit;
  const shellInit = shellInitCmd ? `${shellInitCmd} && ` : '';

  // Run each setup command (output suppressed, errors shown on failure)
  for (let cmd of repoConfig.setup) {
    // Substitute ${MAIN_REPO} with the path to the main repo
    cmd = cmd.replace(/\$\{MAIN_REPO\}/g, mainRepoPath);

    logger.log(`  Running: ${cmd}`);
    try {
      await execa('bash', ['-c', `${shellInit}${cmd}`], {
        cwd: worktreePath,
        stdio: 'pipe',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stdout = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
      const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : '';

      const outputParts = [
        stdout.trim() ? `stdout:\n${stdout.trimEnd()}` : '',
        stderr.trim() ? `stderr:\n${stderr.trimEnd()}` : '',
      ].filter(Boolean);

      const output = outputParts.join('\n\n');
      const clippedOutput = output.length > 4000 ? output.slice(0, 4000) + '\n… (truncated)' : output;

      throw new Error(
        `Setup command "${cmd}" failed in ${repoName}: ${message}` + (clippedOutput ? `\n\n${clippedOutput}` : '')
      );
    }
  }
}
