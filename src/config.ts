// Environment variables are loaded by the CLI via `src/env.ts` (gracefully handles missing .env files)

export const CONFIG = {
  // Worktree settings
  worktreeBasePath: process.env.WORKTREE_BASE_PATH || '/tmp/bye-bye-flag-worktrees',

  // Agent settings
  agentTimeoutMs: 30 * 60 * 1000, // 30 minutes

  // Branch naming
  branchPrefix: 'remove-flag/',

  // Session ID namespace for deterministic UUIDs (must be a valid UUID)
  sessionNamespace: 'f5d6289e-e44a-4f23-a24e-858af0371ed4',
};
