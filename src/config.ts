// Environment variables are loaded by the CLI via `src/env.ts` (gracefully handles missing .env files)

export const CONFIG = {
  // Worktree settings (override via bye-bye-flag-config.json)
  worktreeBasePath: '/tmp/bye-bye-flag-worktrees',

  // Agent settings
  // Default timeout for a single agent run. Can be overridden via bye-bye-flag-config.json.
  agentTimeoutMs: 60 * 60 * 1000, // 60 minutes

  // Branch naming
  branchPrefix: 'remove-flag/',

  // Session ID namespace for deterministic UUIDs (must be a valid UUID)
  sessionNamespace: 'f5d6289e-e44a-4f23-a24e-858af0371ed4',
};
