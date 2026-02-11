import type { AgentPreset } from './types.ts';

export const codexPreset: AgentPreset = {
  command: 'codex',
  args: ['exec', '--skip-git-repo-check', '--full-auto', '-'],
  promptMode: 'stdin',
  versionArgs: ['--version'],
  sessionIdRegex: '^session id:\\s+([0-9a-f-]+)',
  resume: {
    withSessionId: 'cd {{workspacePath}} && {{command}} resume --full-auto {{sessionId}}',
    withoutSessionId: 'cd {{workspacePath}} && {{command}} resume --full-auto --all',
  },
};
