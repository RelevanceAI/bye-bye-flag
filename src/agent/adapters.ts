import { v5 as uuidv5 } from 'uuid';
import { CONFIG } from '../config.ts';
import { type AgentKind, type Logger } from '../types.ts';
import { type AgentConfig, type ByeByeFlagConfig } from './scaffold.ts';
import { type AgentExecutionContract, invokeAgent } from './invoke-agent.ts';
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
  sessionId?: SessionIdConfig;
  resume: AgentResumeTemplates;
}

function resolveTimeoutMs(agentConfig?: { timeoutMinutes?: number }): number {
  if (!agentConfig || agentConfig.timeoutMinutes === undefined) return CONFIG.agentTimeoutMs;
  return agentConfig.timeoutMinutes * 60 * 1000;
}

function mergeResumeTemplates(
  kind: AgentKind,
  presetResume: AgentResumeTemplates | undefined,
  userResume: AgentConfig['resume']
): AgentResumeTemplates {
  const withoutSessionId = userResume?.withoutSessionId ?? presetResume?.withoutSessionId;
  const withSessionId = userResume?.withSessionId ?? presetResume?.withSessionId;

  if (!withoutSessionId) {
    throw new Error(
      `Agent "${kind}" is missing resume.withoutSessionId. Set agent.resume.withoutSessionId in bye-bye-flag-config.json or add it in the preset.`
    );
  }

  return { withoutSessionId, withSessionId };
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
    sessionId: preset?.sessionId,
    resume: mergeResumeTemplates(kind, preset?.resume, userConfig?.resume),
  };
}

function createGeneratedSessionId(branchName: string): string {
  const uniqueKey = `${branchName}-${Date.now()}`;
  return uuidv5(uniqueKey, CONFIG.sessionNamespace);
}

export function stripArgPairOrInline(args: string[], argName: string, argValue: string): string[] {
  const strippedArgs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const current = args[index];
    const next = args[index + 1];

    if (current === argName) {
      if (next === argValue) index++;
      continue;
    }

    if (current.startsWith(`${argName}=`)) {
      const value = current.slice(argName.length + 1);
      if (value === argValue) continue;
    }

    strippedArgs.push(current);
  }

  return strippedArgs;
}

function extractSessionIdFromOutput(stdout: string, sessionIdRegex?: string): string | undefined {
  if (!sessionIdRegex) return undefined;
  try {
    const regex = new RegExp(sessionIdRegex, 'm');
    const match = stdout.match(regex);
    if (!match) return undefined;
    return match[1] || match[0];
  } catch {
    return undefined;
  }
}

function renderResumeTemplate(
  template: string,
  values: { workspacePath: string; sessionId?: string; command: string }
): string {
  return template
    .replace(/\{\{workspacePath\}\}/g, values.workspacePath)
    .replace(/\{\{sessionId\}\}/g, values.sessionId ?? '')
    .replace(/\{\{command\}\}/g, values.command);
}

function createExecutionContract(
  resolved: ResolvedAgentConfig,
  branchName: string
): { contract: AgentExecutionContract; initialSessionId?: string } {
  const invocationArgs = [...resolved.args];
  let initialSessionId: string | undefined;

  if (resolved.sessionId?.strategy === 'generated-v5-branch-timestamp') {
    initialSessionId = createGeneratedSessionId(branchName);
    invocationArgs.push(resolved.sessionId.arg, initialSessionId);
  }

  const retryArgs =
    resolved.sessionId && initialSessionId
      ? stripArgPairOrInline(invocationArgs, resolved.sessionId.arg, initialSessionId)
      : [...invocationArgs];

  const contract: AgentExecutionContract = {
    invocationArgs,
    retryArgs,
    extractSessionId: (stdout) =>
      extractSessionIdFromOutput(stdout, resolved.sessionIdRegex) ?? initialSessionId,
    buildResumeCommand: (command, workspacePath, sessionId) => {
      if (sessionId && resolved.resume.withSessionId) {
        return renderResumeTemplate(resolved.resume.withSessionId, { workspacePath, sessionId, command });
      }
      return renderResumeTemplate(resolved.resume.withoutSessionId, { workspacePath, command });
    },
  };

  return { contract, initialSessionId };
}

export function resolveAgentRuntime(config: ByeByeFlagConfig): AgentRuntime {
  const resolved = resolveAgentConfig(config);

  return {
    kind: resolved.kind,
    prerequisiteCommand: resolved.command,
    prerequisiteArgs: resolved.versionArgs,
    async invoke(context: AgentInvocationContext): Promise<AgentInvocationResult> {
      const { contract, initialSessionId } = createExecutionContract(resolved, context.branchName);

      const result = await invokeAgent({
        kind: resolved.kind,
        workspacePath: context.workspacePath,
        reposDir: context.reposDir,
        configPath: context.configPath,
        prompt: context.prompt,
        command: resolved.command,
        promptMode: resolved.promptMode,
        promptArg: resolved.promptArg,
        timeoutMs: resolved.timeoutMs,
        execution: contract,
        logger: context.logger,
      });

      return {
        kind: resolved.kind,
        output: result.output,
        sessionId: result.sessionId ?? initialSessionId,
        resumeCommand: result.resumeCommand,
      };
    },
  };
}
