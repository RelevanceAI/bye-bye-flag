// Environment variables loaded via Node's --env-file-if-exists flag (gracefully handles missing .env files)

export const CONFIG = {
  // Worktree settings
  worktreeBasePath: process.env.WORKTREE_BASE_PATH || '/tmp/bye-bye-flag-worktrees',

  // Claude Code settings
  claudeTimeout: 30 * 60 * 1000, // 30 minutes

  // Branch naming
  branchPrefix: 'remove-flag/',

  // Session ID namespace for deterministic UUIDs (must be a valid UUID)
  sessionNamespace: 'f5d6289e-e44a-4f23-a24e-858af0371ed4',
};
