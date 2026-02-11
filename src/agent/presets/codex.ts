import type { AgentPreset } from './types.ts';

export const codexPreset: AgentPreset = {
  command: 'codex',
  args: ['exec', '--skip-git-repo-check', '--full-auto', '-'],
  promptMode: 'stdin',
  versionArgs: ['--version'],
  resume: {
    withoutSessionId: 'cd {{workspacePath}} && {{command}} resume --all',
  },
};
