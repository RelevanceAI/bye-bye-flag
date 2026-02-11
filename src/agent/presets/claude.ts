import type { AgentPreset } from './types.ts';

export const claudePreset: AgentPreset = {
  command: 'claude',
  args: ['--dangerously-skip-permissions'],
  promptMode: 'arg',
  promptArg: '-p',
  versionArgs: ['--version'],
  sessionId: {
    strategy: 'generated-v5-branch-timestamp',
    arg: '--session-id',
  },
  resume: {
    withSessionId: 'cd {{workspacePath}} && {{command}} --resume {{sessionId}}',
    withoutSessionId: 'cd {{workspacePath}} && {{command}} --resume',
  },
};
