import { z } from 'zod';

export interface RemovalRequest {
  flagKey: string;
  keepBranch: 'enabled' | 'disabled';
  dryRun?: boolean;
  keepWorktree?: boolean; // Don't cleanup worktree (for manual inspection)

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
