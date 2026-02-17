export interface AgentResumeTemplates {
  withoutSessionId: string;
  withSessionId?: string;
}

export interface SessionIdConfig {
  strategy: 'generated-v5-branch-timestamp';
  arg: string;
}

export interface AgentPreset {
  command: string;
  args: string[];
  promptMode: 'stdin' | 'arg';
  promptArg?: string;
  versionArgs: string[];
  sessionIdRegex?: string;
  resume: AgentResumeTemplates;
  sessionId?: SessionIdConfig;
}
