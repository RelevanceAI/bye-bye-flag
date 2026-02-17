import { spawn } from 'child_process';
import { parseAgentOutputFromText } from './output.ts';
import { getShellInit } from './scaffold.ts';
import { registerChildProcess } from '../process-tracker.ts';
import { type AgentOutput, type Logger, consoleLogger } from '../types.ts';

interface GenericRunResult {
  stdout: string;
  timedOut: boolean;
  exitCode: number | null;
}

export interface InvokeAgentOptions {
  kind: string;
  workspacePath: string;
  reposDir: string;
  configPath?: string;
  prompt: string;
  command: string;
  promptMode: 'stdin' | 'arg';
  promptArg: string;
  timeoutMs: number;
  execution: AgentExecutionContract;
  logger?: Logger;
}

export interface InvokeAgentResult {
  output: AgentOutput;
  sessionId?: string;
  resumeCommand: string;
}

export interface AgentExecutionContract {
  invocationArgs: string[];
  retryArgs: string[];
  extractSessionId(stdout: string): string | undefined;
  buildResumeCommand(command: string, workspacePath: string, sessionId?: string): string;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const MAX_NORMALIZE_PROMPT_OUTPUT_LENGTH = 12_000;
const MAX_NORMALIZE_DURATION_MS = 5 * 60 * 1000;

function buildNormalizationPrompt(rawOutput: string): string {
  const truncatedOutput =
    rawOutput.length > MAX_NORMALIZE_PROMPT_OUTPUT_LENGTH
      ? rawOutput.slice(0, 4000) + '\n\n[... truncated middle section ...]\n\n' + rawOutput.slice(-8000)
      : rawOutput;

  return `You are a formatter. Convert the following feature flag removal output to this exact JSON format.
Output ONLY the JSON object, with no markdown and no extra text.

{
  "status": "success" or "refused",
  "summary": "brief description of what was done",
  "filesChanged": ["array", "of", "file", "paths"],
  "testsPass": true/false,
  "lintPass": true/false,
  "typecheckPass": true/false,
  "verificationDetails": {
    "tests": "optional brief failure detail (only when testsPass=false)",
    "lint": "optional brief failure detail (only when lintPass=false)",
    "typecheck": "optional brief failure detail (only when typecheckPass=false)"
  }
}

Rules:
- If tests/lint/typecheck were skipped or not run, set them to true.
- If the task was refused (e.g. flag not found), set status to "refused".
- Include verificationDetails entries only for checks that failed.
- Do not execute tools, commands, or edits. Only transform text into the JSON object.

Output to convert:

${truncatedOutput}`;
}

async function normalizeAgentOutputWithSameAgent(options: {
  kind: string;
  command: string;
  args: string[];
  promptMode: 'stdin' | 'arg';
  promptArg: string;
  timeoutMs: number;
  workspacePath: string;
  shellInit?: string;
  logger: Logger;
  rawOutput: string;
}): Promise<AgentOutput | null> {
  const {
    kind,
    command,
    args,
    promptMode,
    promptArg,
    timeoutMs,
    workspacePath,
    shellInit,
    logger,
    rawOutput,
  } = options;

  logger.log(`[${kind}] Parse failed, attempting normalization retry with the same agent...`);

  const normalizePrompt = buildNormalizationPrompt(rawOutput);
  const normalizeArgs = promptMode === 'arg' ? [...args, promptArg, normalizePrompt] : args;

  const normalizeResult = await runCli(
    command,
    normalizeArgs,
    normalizePrompt,
    promptMode,
    Math.min(timeoutMs, MAX_NORMALIZE_DURATION_MS),
    workspacePath,
    shellInit,
    `${kind}:normalize`,
    logger
  );

  if (normalizeResult.timedOut) {
    logger.error(`[${kind}] Normalization retry timed out.`);
    return null;
  }

  if (!normalizeResult.stdout || normalizeResult.stdout.length === 0) {
    logger.error(`[${kind}] Normalization retry produced no output.`);
    return null;
  }

  return parseAgentOutputFromText(normalizeResult.stdout);
}

function runCli(
  command: string,
  args: string[],
  prompt: string,
  promptMode: 'stdin' | 'arg',
  timeoutMs: number,
  cwd: string,
  shellInit: string | undefined,
  logPrefix: string,
  logger: Logger
): Promise<GenericRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let lineBuffer = '';
    let timedOut = false;

    const shellPrefix = shellInit ? `${shellInit} && ` : '';
    const quotedArgs = args.map((arg) => quoteShellArg(arg)).join(' ');
    const cmd = quotedArgs.length > 0 ? `${shellPrefix}${command} ${quotedArgs}` : `${shellPrefix}${command}`;

    const child = spawn('bash', ['-c', cmd], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    registerChildProcess(child);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    if (promptMode === 'stdin') {
      child.stdin.write(prompt);
    }
    child.stdin.end();

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      lineBuffer += text;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        logger.log(`[${logPrefix}] ${line}`);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) logger.error(text);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (lineBuffer.trim()) {
        logger.log(`[${logPrefix}] ${lineBuffer.trim()}`);
      }
      resolve({ stdout, timedOut, exitCode: code });
    });

    child.on('error', () => {
      clearTimeout(timeoutHandle);
      resolve({ stdout, timedOut: false, exitCode: 1 });
    });
  });
}

export async function invokeAgent(options: InvokeAgentOptions): Promise<InvokeAgentResult> {
  const {
    kind,
    workspacePath,
    reposDir,
    configPath,
    prompt,
    command,
    promptMode,
    promptArg,
    timeoutMs,
    execution,
    logger = consoleLogger,
  } = options;

  const invocationArgs =
    promptMode === 'arg' ? [...execution.invocationArgs, promptArg, prompt] : execution.invocationArgs;

  const shellInit = await getShellInit(reposDir, undefined, configPath);

  logger.log(`--- ${kind} Output ---`);
  const result = await runCli(
    command,
    invocationArgs,
    prompt,
    promptMode,
    timeoutMs,
    workspacePath,
    shellInit,
    kind,
    logger
  );
  logger.log(`--- End ${kind} Output ---`);
  logger.log(`${kind} exit code: ${result.exitCode}`);

  if (result.timedOut) {
    throw new Error(`${kind} session timed out`);
  }

  if (!result.stdout || result.stdout.length === 0) {
    throw new Error(`${kind} produced no output`);
  }

  const parsed = parseAgentOutputFromText(result.stdout);
  const retryArgs = execution.retryArgs;
  const output =
    parsed ??
    (await normalizeAgentOutputWithSameAgent({
      kind,
      command,
      args: retryArgs,
      promptMode,
      promptArg,
      timeoutMs,
      workspacePath,
      shellInit,
      logger,
      rawOutput: result.stdout,
    }));

  if (!output) {
    const preview =
      result.stdout.length > 800 ? result.stdout.slice(0, 800) + '\n… (truncated)' : result.stdout;
    throw new Error(`Failed to parse ${kind} output as AgentOutput.\n\nOutput preview:\n${preview}`);
  }

  const sessionId = execution.extractSessionId(result.stdout);
  const resumeCommand = execution.buildResumeCommand(command, workspacePath, sessionId);

  return {
    output,
    sessionId,
    resumeCommand,
  };
}
