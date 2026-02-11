import { claudePreset } from './claude.ts';
import { codexPreset } from './codex.ts';
import type { AgentPreset } from './types.ts';

const PRESETS: Record<string, AgentPreset> = {
  claude: claudePreset,
  codex: codexPreset,
};

export function getAgentPreset(type: string): AgentPreset | undefined {
  return PRESETS[type];
}
