import { z } from 'zod';

/**
 * Simple logger interface used throughout the codebase.
 * When not provided, modules fall back to console.log/console.error.
 */
export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

/**
 * Default logger that writes to console
 */
export const consoleLogger: Logger = {
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
};

export interface RemovalRequest {
  flagKey: string;
  keepBranch: 'enabled' | 'disabled';
  dryRun?: boolean;
  keepWorktree?: boolean; // Don't cleanup worktree (for manual inspection)
  // TODO: Revisit - should we always skip fetch? Depends on whether we need standalone agent usage
  skipFetch?: boolean; // Skip git fetch (when orchestrator already fetched)

  // Directory containing bye-bye-flag.json and one or more git repos as subdirectories
  reposDir: string;
}

export interface RepoResult {
  repoName: string;
  repoPath: string;
  status: 'success' | 'no-changes' | 'failed';
  prUrl?: string;
  error?: string;
}

export interface RemovalResult {
  status: 'success' | 'refused' | 'failed';

  branchName?: string;
  summary?: string;
  filesChanged?: string[];

  // Multi-repo: one result per repo
  repoResults?: RepoResult[];

  // On refusal
  refusalReason?: string;

  // On failure
  error?: string;
}

// Schema for validating Claude Code's structured output
export const AgentOutputSchema = z.object({
  status: z.enum(['success', 'refused']),
  summary: z.string(),
  filesChanged: z.array(z.string()),
  testsPass: z.boolean(),
  lintPass: z.boolean(),
  typecheckPass: z.boolean(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;
