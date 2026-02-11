import { v5 as uuidv5 } from 'uuid';
import { CONFIG } from '../config.ts';
import { type AgentKind, type Logger } from '../types.ts';
import { type AgentConfig, type ByeByeFlagConfig } from './scaffold.ts';
import { invokeAgent } from './invoke-agent.ts';
import { getAgentPreset } from './presets/index.ts';
import type { AgentResumeTemplates, SessionIdConfig } from './presets/types.ts';

export interface AgentInvocationContext {
  workspacePath: string;
  branchName: string;
  prompt: string;
  reposDir: string;
  configPath?: string;
  logger?: Logger;
}

export interface AgentInvocationResult {
  kind: AgentKind;
  output: {
    status: 'success' | 'refused';
    summary: string;
    filesChanged: string[];
    testsPass: boolean;
    lintPass: boolean;
    typecheckPass: boolean;
    verificationDetails?: {
      tests?: string;
      lint?: string;
      typecheck?: string;
    };
  };
  sessionId?: string;
  resumeCommand: string;
}

export interface AgentRuntime {
  kind: AgentKind;
  prerequisiteCommand: string;
  prerequisiteArgs: string[];
  invoke(context: AgentInvocationContext): Promise<AgentInvocationResult>;
}

interface ResolvedAgentConfig {
  kind: AgentKind;
  command: string;
  args: string[];
  promptMode: 'stdin' | 'arg';
  promptArg: string;
  timeoutMs: number;
  versionArgs: string[];
  sessionIdRegex?: string;
  resume?: AgentResumeTemplates;
  sessionId?: SessionIdConfig;
}

function resolveTimeoutMs(agentConfig?: { timeoutMinutes?: number }): number {
  if (!agentConfig || agentConfig.timeoutMinutes === undefined) return CONFIG.agentTimeoutMs;
  return agentConfig.timeoutMinutes * 60 * 1000;
}

function mergeResumeTemplates(
  presetResume: AgentResumeTemplates | undefined,
  userResume: AgentConfig['resume']
): AgentResumeTemplates | undefined {
  const withSessionId = userResume?.withSessionId ?? presetResume?.withSessionId;
  const withoutSessionId = userResume?.withoutSessionId ?? presetResume?.withoutSessionId;

  if (!withSessionId && !withoutSessionId) return undefined;
  return { withSessionId, withoutSessionId };
}

function resolveAgentConfig(config: ByeByeFlagConfig): ResolvedAgentConfig {
  const userConfig = config.agent;
  const kind = (userConfig?.type ?? 'claude') as AgentKind;
  const preset = getAgentPreset(kind);

  const command = (userConfig?.command ?? preset?.command ?? kind).trim();
  const args = [...(preset?.args ?? []), ...(userConfig?.args ?? [])];
  const promptMode = userConfig?.promptMode ?? preset?.promptMode ?? 'stdin';
  const promptArg = userConfig?.promptArg ?? preset?.promptArg ?? '-p';
  const versionArgs =
    userConfig?.versionArgs && userConfig.versionArgs.length > 0
      ? userConfig.versionArgs
      : (preset?.versionArgs ?? ['--version']);

  return {
    kind,
    command,
    args,
    promptMode,
    promptArg,
    timeoutMs: resolveTimeoutMs(userConfig),
    versionArgs,
    sessionIdRegex: userConfig?.sessionIdRegex ?? preset?.sessionIdRegex,
    resume: mergeResumeTemplates(preset?.resume, userConfig?.resume),
    sessionId: preset?.sessionId,
  };
}

function createGeneratedSessionId(branchName: string): string {
  const uniqueKey = `${branchName}-${Date.now()}`;
  return uuidv5(uniqueKey, CONFIG.sessionNamespace);
}

export function resolveAgentRuntime(config: ByeByeFlagConfig): AgentRuntime {
  const resolved = resolveAgentConfig(config);

  return {
    kind: resolved.kind,
    prerequisiteCommand: resolved.command,
    prerequisiteArgs: resolved.versionArgs,
    async invoke(context: AgentInvocationContext): Promise<AgentInvocationResult> {
      let sessionId: string | undefined;
      const args = [...resolved.args];

      if (resolved.sessionId?.strategy === 'generated-v5-branch-timestamp') {
        sessionId = createGeneratedSessionId(context.branchName);
        args.push(resolved.sessionId.arg, sessionId);
      }

      const result = await invokeAgent({
        kind: resolved.kind,
        workspacePath: context.workspacePath,
        reposDir: context.reposDir,
        configPath: context.configPath,
        prompt: context.prompt,
        command: resolved.command,
        args,
        promptMode: resolved.promptMode,
        promptArg: resolved.promptArg,
        timeoutMs: resolved.timeoutMs,
        sessionIdRegex: resolved.sessionIdRegex,
        resume: resolved.resume,
        sessionId,
        logger: context.logger,
      });

      return {
        kind: resolved.kind,
        output: result.output,
        sessionId: result.sessionId,
        resumeCommand: result.resumeCommand,
      };
    },
  };
}
