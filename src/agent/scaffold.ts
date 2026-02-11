import { execa } from 'execa';
import * as path from 'path';
import * as fs from 'fs/promises';
import { z } from 'zod';
import { CONFIG } from '../config.ts';
import { consoleLogger, type Logger } from '../types.ts';

export interface ScaffoldOptions {
  reposDir: string; // Directory containing bye-bye-flag-config.json and repo subdirectories
  configPath?: string; // Optional explicit path to config file
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

interface WorkspaceMetadata {
  createdBy: 'bye-bye-flag';
  reposDir: string;
  branchName: string;
  createdAt: string;
}

const WORKSPACE_METADATA_FILENAME = '.bye-bye-flag-workspace.json';
const repoOperationLocks = new Map<string, Promise<void>>();

async function withRepoOperationLock<T>(repoPath: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoPath);
  const previous = (repoOperationLocks.get(key) ?? Promise.resolve()).catch(() => undefined);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  repoOperationLocks.set(key, tail);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (repoOperationLocks.get(key) === tail) {
      repoOperationLocks.delete(key);
    }
  }
}

async function writeWorkspaceMetadata(
  workspacePath: string,
  reposDir: string,
  branchName: string
): Promise<void> {
  const metadata: WorkspaceMetadata = {
    createdBy: 'bye-bye-flag',
    reposDir: path.resolve(reposDir),
    branchName,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(workspacePath, WORKSPACE_METADATA_FILENAME),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  );
}

export async function readWorkspaceMetadata(workspacePath: string): Promise<WorkspaceMetadata | null> {
  const metadataPath = path.join(workspacePath, WORKSPACE_METADATA_FILENAME);
  try {
    const raw = await fs.readFile(metadataPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceMetadata>;
    if (
      parsed.createdBy !== 'bye-bye-flag' ||
      typeof parsed.reposDir !== 'string' ||
      typeof parsed.branchName !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return {
      createdBy: 'bye-bye-flag',
      reposDir: parsed.reposDir,
      branchName: parsed.branchName,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Creates worktrees for all git repos configured in bye-bye-flag-config.json
 * Returns a workspace root containing all worktrees
 */
export async function setupMultiRepoWorktrees(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { reposDir, configPath, branchName, deleteRemoteBranch = true, logger = consoleLogger } = options;
  const config = await readConfig(reposDir, configPath);
  const worktreeBasePath = config.worktrees?.basePath ?? CONFIG.worktreeBasePath;
  const workspacePath = path.join(worktreeBasePath, branchName.replace(/\//g, '-'));

  // Ensure workspace path exists
  await fs.mkdir(workspacePath, { recursive: true });
  await writeWorkspaceMetadata(workspacePath, reposDir, branchName);

  // Validate repos
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
        throw new Error(`Configured repo "${repoName}" does not exist in ${reposDir}`, { cause: error });
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

    await withRepoOperationLock(repoPath, async () => {
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
        await execa('git', ['push', 'origin', '--delete', branchName], {
          cwd: repoPath,
          reject: false,
        });
      }

      const baseBranch = getRepoBaseBranch(config, repoName);

      // Create worktree with the new branch based on the configured origin base branch
      logger.log(`[${repoName}] Creating worktree on branch ${branchName}...`);
      await execa('git', ['worktree', 'add', '-b', branchName, worktreePath, `origin/${baseBranch}`], {
        cwd: repoPath,
      });
    });

    // Setup node and run setup commands
    logger.log(`[${repoName}] Running setup commands...`);
    await runSetupCommands(worktreePath, reposDir, logger, configPath);
    logger.log(`[${repoName}] Setup complete`);

    return {
      name: repoName,
      originalPath: repoPath,
      worktreePath,
    };
  });

  const setupResults = await Promise.allSettled(repoSetupPromises);
  const repos: ScaffoldResult['repos'] = [];
  const failures: string[] = [];

  for (let index = 0; index < setupResults.length; index++) {
    const result = setupResults[index];
    if (result.status === 'fulfilled') {
      repos.push(result.value);
      continue;
    }
    const repoName = configuredRepos[index];
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(`${repoName}: ${reason}`);
  }

  if (failures.length > 0) {
    // Best-effort rollback so setup failures do not leave partial worktrees behind.
    for (const repoName of configuredRepos) {
      const repoPath = path.join(reposDir, repoName);
      const worktreePath = path.join(workspacePath, repoName);
      await cleanupWorktree(repoPath, worktreePath);
    }
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors while surfacing the original failure.
    }

    throw new Error(`Failed to setup worktrees:\n${failures.join('\n')}`);
  }

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
async function cleanupWorktree(
  repoPath: string,
  worktreePath: string,
  logger: Logger = consoleLogger
): Promise<void> {
  logger.log(`Cleaning up worktree at ${worktreePath}...`);
  try {
    await execa('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoPath,
    });
  } catch (error) {
    logger.error(`Failed to remove worktree: ${error}`);
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

const RepoEntrySchema = z
  .object({
    shellInit: z.string().optional(), // Override shell init for this repo
    baseBranch: z.string().min(1).optional(), // Base branch for worktree creation + code search
    mainSetup: z.array(z.string()).optional(), // Setup commands for main repo (run once by orchestrator)
    setup: z.array(z.string()).optional(), // Setup commands for worktrees (run per flag)
  })
  .strict();

const OrchestratorSettingsSchema = z
  .object({
    concurrency: z.number().int().positive().optional(),
    maxPrs: z.number().int().nonnegative().optional(),
    logDir: z.string().optional(),
  })
  .strict();

const WorktreesSchema = z
  .object({
    basePath: z.string().optional(),
  })
  .strict();

const RepoDefaultsSchema = z
  .object({
    shellInit: z.string().optional(),
    baseBranch: z.string().min(1).optional(),
    mainSetup: z.array(z.string()).optional(),
    setup: z.array(z.string()).optional(),
  })
  .strict();

const FetcherConfigSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('posthog'),
      projectIds: z
        .array(z.union([z.string(), z.number().int().positive()]))
        .min(1)
        .transform((ids) => ids.map(String)),
      staleDays: z.number().int().positive().optional(),
      host: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('manual') }).strict(),
]);

const AgentConfigSchema = z
  .object({
    /**
     * Agent identifier.
     * Built-in preset values include "claude" and "codex".
     */
    type: z.string().min(1),
    /**
     * CLI command to execute. Defaults to `type` when omitted.
     * Example: "opencode", "amp", "pi".
     */
    command: z.string().min(1).optional(),
    /**
     * Extra args passed to the CLI command.
     */
    args: z.array(z.string()).optional(),
    /**
     * Timeout for a single agent run (in minutes).
     */
    timeoutMinutes: z.number().int().positive().optional(),
    /**
     * How the prompt is delivered to the agent.
     * - "stdin": prompt is piped to stdin (default).
     * - "arg": prompt is passed via `promptArg`.
     */
    promptMode: z.enum(['stdin', 'arg']).optional(),
    /**
     * Prompt flag used when promptMode="arg" (default "-p").
     */
    promptArg: z.string().min(1).optional(),
    /**
     * Version args used for prerequisite checks (default ["--version"]).
     */
    versionArgs: z.array(z.string()).optional(),
    /**
     * Optional regex to extract session ID from agent output.
     * If the regex has a capture group, group 1 is used.
     */
    sessionIdRegex: z.string().min(1).optional(),
    /**
     * Optional resume command templates for PR metadata.
     */
    resume: z
      .object({
        withSessionId: z.string().min(1).optional(),
        withoutSessionId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.promptMode === 'arg' && (!cfg.promptArg || cfg.promptArg.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promptArg'],
        message: 'promptArg is required when promptMode is "arg".',
      });
    }
  });

const ByeByeFlagConfigSchema = z
  .object({
    fetcher: FetcherConfigSchema.optional(),
    agent: AgentConfigSchema.optional(),
    worktrees: WorktreesSchema.optional(),
    orchestrator: OrchestratorSettingsSchema.optional(),
    repoDefaults: RepoDefaultsSchema.optional(),
    repos: z.record(RepoEntrySchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const [repoName, repoCfg] of Object.entries(cfg.repos)) {
      const hasSetup = repoCfg.setup !== undefined || cfg.repoDefaults?.setup !== undefined;
      if (!hasSetup) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repos', repoName, 'setup'],
          message: 'Missing setup commands. Set repos.<name>.setup or repoDefaults.setup.',
        });
      }

      const hasBaseBranch =
        (typeof repoCfg.baseBranch === 'string' && repoCfg.baseBranch.trim().length > 0) ||
        (typeof cfg.repoDefaults?.baseBranch === 'string' && cfg.repoDefaults.baseBranch.trim().length > 0);
      if (!hasBaseBranch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repos', repoName, 'baseBranch'],
          message: 'Missing baseBranch. Set repos.<name>.baseBranch or repoDefaults.baseBranch.',
        });
      }
    }
  });

export type ByeByeFlagConfig = z.infer<typeof ByeByeFlagConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function getRepoBaseBranch(config: ByeByeFlagConfig, repoName: string): string {
  const repoConfig = config.repos[repoName];
  if (!repoConfig) {
    throw new Error(`No config entry for repo "${repoName}" in bye-bye-flag-config.json`);
  }
  const baseBranch = repoConfig.baseBranch ?? config.repoDefaults?.baseBranch;
  if (!baseBranch || baseBranch.trim().length === 0) {
    throw new Error(
      `Missing baseBranch for repo "${repoName}". Set repos.${repoName}.baseBranch or repoDefaults.baseBranch.`
    );
  }
  return baseBranch;
}

let cachedConfig: ByeByeFlagConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Reads bye-bye-flag-config.json from the repos root directory
 * Optionally accepts an explicit configPath
 * Throws if config file is missing
 */
export const CONFIG_FILENAME = 'bye-bye-flag-config.json';

function resolveConfigPath(reposDir: string, configPath?: string): string {
  if (configPath) return path.resolve(configPath);
  return path.join(reposDir, CONFIG_FILENAME);
}

export async function readConfig(reposDir: string, configPath?: string): Promise<ByeByeFlagConfig> {
  const preferredPath = resolveConfigPath(reposDir, configPath);

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
      throw new Error(`Failed to read config file: ${preferredPath}\n${message}`, { cause: error });
    }
    throw new Error(`Missing required config file: ${preferredPath}`, { cause: error });
  }

  try {
    const parsed = ByeByeFlagConfigSchema.parse(JSON.parse(content));
    cachedConfig = parsed;
    cachedConfigPath = preferredPath;
    return cachedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
      throw new Error(`Invalid config file: ${preferredPath}\n${issues}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Gets the shellInit command for a specific repo (or default)
 */
export async function getShellInit(
  reposDir: string,
  repoName?: string,
  configPath?: string
): Promise<string | undefined> {
  const config = await readConfig(reposDir, configPath);
  if (repoName && config.repos[repoName]?.shellInit !== undefined) {
    return config.repos[repoName].shellInit;
  }
  return config.repoDefaults?.shellInit;
}

/**
 * Runs setup commands for a repo
 * Requires bye-bye-flag-config.json with an entry for this repo
 * Supports ${MAIN_REPO} substitution to reference the main repo path
 */
async function runSetupCommands(
  worktreePath: string,
  reposDir: string,
  logger: Logger,
  configPath?: string
): Promise<void> {
  const repoName = path.basename(worktreePath);
  const config = await readConfig(reposDir, configPath);
  // Use absolute path so it works from worktree location
  const mainRepoPath = path.resolve(reposDir, repoName);

  const repoConfig = config.repos[repoName];
  if (!repoConfig) {
    throw new Error(`No config entry for repo "${repoName}" in bye-bye-flag-config.json`);
  }

  // Per-repo shellInit takes precedence over repoDefaults
  const shellInitCmd = repoConfig.shellInit ?? config.repoDefaults?.shellInit;
  const shellInit = shellInitCmd ? `${shellInitCmd} && ` : '';

  const setupCommands = repoConfig.setup !== undefined ? repoConfig.setup : config.repoDefaults?.setup;
  if (!setupCommands) {
    throw new Error(
      `Missing setup commands for repo "${repoName}". Add repos.${repoName}.setup or repoDefaults.setup to bye-bye-flag-config.json`
    );
  }

  // Run each setup command (output suppressed, errors shown on failure)
  for (const rawCmd of setupCommands) {
    // Substitute ${MAIN_REPO} with the path to the main repo
    const cmd = rawCmd.replace(/\$\{MAIN_REPO\}/g, mainRepoPath);

    logger.log(`  Running: ${cmd}`);
    try {
      await execa('bash', ['-c', `${shellInit}${cmd}`], {
        cwd: worktreePath,
        stdio: 'pipe',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stdout =
        typeof (error as { stdout?: unknown }).stdout === 'string'
          ? (error as { stdout: string }).stdout
          : '';
      const stderr =
        typeof (error as { stderr?: unknown }).stderr === 'string'
          ? (error as { stderr: string }).stderr
          : '';

      const outputParts = [
        stdout.trim() ? `stdout:\n${stdout.trimEnd()}` : '',
        stderr.trim() ? `stderr:\n${stderr.trimEnd()}` : '',
      ].filter(Boolean);

      const output = outputParts.join('\n\n');
      const clippedOutput = output.length > 4000 ? output.slice(0, 4000) + '\n… (truncated)' : output;

      throw new Error(
        `Setup command "${cmd}" failed in ${repoName}: ${message}` +
          (clippedOutput ? `\n\n${clippedOutput}` : ''),
        { cause: error }
      );
    }
  }
}
