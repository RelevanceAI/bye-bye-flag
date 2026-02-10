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

export type AgentKind = 'claude' | 'codex';

// Schema for validating the agent's structured output
export const AgentOutputSchema = z.object({
  status: z.enum(['success', 'refused']),
  summary: z.string(),
  filesChanged: z.array(z.string()),
  testsPass: z.boolean(),
  lintPass: z.boolean(),
  typecheckPass: z.boolean(),
  verificationDetails: z
    .object({
      tests: z.string().optional(),
      lint: z.string().optional(),
      typecheck: z.string().optional(),
    })
    .optional(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;
