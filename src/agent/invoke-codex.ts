import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CONFIG } from '../config.ts';
import { AgentOutputSchema, consoleLogger, type AgentOutput, type Logger } from '../types.ts';
import { parseAgentOutputFromText } from './output.ts';
import { registerChildProcess } from '../process-tracker.ts';
import { getShellInit } from './scaffold.ts';

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

const MAX_EVENT_LOG_CHARS = 3000;

function buildAgentOutputJsonSchema(): unknown {
  // Keep this in sync with AgentOutputSchema in src/types.ts.
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'filesChanged', 'testsPass', 'lintPass', 'typecheckPass'],
    properties: {
      status: { type: 'string', enum: ['success', 'refused'] },
      summary: { type: 'string' },
      filesChanged: { type: 'array', items: { type: 'string' } },
      testsPass: { type: 'boolean' },
      lintPass: { type: 'boolean' },
      typecheckPass: { type: 'boolean' },
    },
  };
}

function tryFormatJsonEventForLog(event: unknown, rawLine: string): string | null {
  if (!event || typeof event !== 'object') return null;
  const obj = event as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : undefined;
  if (!type) return null;

  // Suppress ultra-noisy token deltas if present.
  if (type.toLowerCase().includes('delta')) return null;

  if (type === 'item.completed') {
    const item = obj.item;
    if (item && typeof item === 'object') {
      const itemObj = item as Record<string, unknown>;
      const itemType = typeof itemObj.type === 'string' ? itemObj.type : undefined;
      if (itemType === 'reasoning') {
        const text = typeof itemObj.text === 'string' ? itemObj.text : '';
        const len = text ? ` (${text.length} chars suppressed)` : ' (suppressed)';
        return `[Codex] item.completed: reasoning${len}`;
      }
    }
  }

  const line = rawLine.length > MAX_EVENT_LOG_CHARS ? rawLine.slice(0, MAX_EVENT_LOG_CHARS) + '… (truncated)' : rawLine;
  return `[Codex] ${line}`;
}

function tryFindSessionIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const obj = event as Record<string, unknown>;

  const candidates: Array<unknown> = [
    obj.session_id,
    obj.sessionId,
    obj.conversation_id,
    obj.conversationId,
    obj.thread_id,
    obj.threadId,
    (obj.session && typeof obj.session === 'object'
      ? (obj.session as Record<string, unknown>).id
      : undefined),
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && UUID_RE.test(value)) return value;
  }

  return undefined;
}

function shouldAddFullAuto(extraArgs: string[]): boolean {
  // If the caller already specified a sandbox/approval mode, don't force --full-auto.
  const hasDangerous = extraArgs.includes('--dangerously-bypass-approvals-and-sandbox');
  const hasFullAuto = extraArgs.includes('--full-auto');
  const hasSandbox = extraArgs.includes('--sandbox') || extraArgs.includes('-s');
  return !(hasDangerous || hasFullAuto || hasSandbox);
}

interface RunResult {
  stdout: string;
  timedOut: boolean;
  exitCode: number | null;
  sessionId?: string;
}

function runCodexExec(
  args: string[],
  cwd: string,
  prompt: string,
  timeoutMs: number,
  shellInit: string | undefined,
  logger: Logger
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let lineBuffer = '';
    let timedOut = false;
    let sessionId: string | undefined;

    const quotedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const shellPrefix = shellInit ? `${shellInit} && ` : '';
    const child = spawn('bash', ['-c', `${shellPrefix}codex ${quotedArgs}`], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    registerChildProcess(child);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      lineBuffer += text;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Prefer parsing JSONL events if --json is enabled. Ignore non-JSON lines.
        try {
          const event = JSON.parse(trimmed);
          if (!sessionId) sessionId = tryFindSessionIdFromEvent(event);
          const formatted = tryFormatJsonEventForLog(event, trimmed);
          if (formatted) logger.log(formatted);
        } catch {
          // Non-JSON output (warnings, etc.) — still helpful in logs.
          logger.log(trimmed);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(chunk.toString().trimEnd());
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (lineBuffer.trim()) {
        const trimmed = lineBuffer.trim();
        try {
          const event = JSON.parse(trimmed);
          if (!sessionId) sessionId = tryFindSessionIdFromEvent(event);
          const formatted = tryFormatJsonEventForLog(event, trimmed);
          if (formatted) logger.log(formatted);
        } catch {
          logger.log(trimmed);
        }
      }

      resolve({ stdout, timedOut, exitCode: code, sessionId });
    });

    child.on('error', () => {
      clearTimeout(timeoutHandle);
      resolve({ stdout, timedOut: false, exitCode: 1, sessionId });
    });
  });
}

export interface InvokeCodexResult {
  output: AgentOutput;
  sessionId?: string;
}

export async function invokeCodexCli(
  worktreePath: string,
  prompt: string,
  reposDir: string,
  repoName?: string,
  configPath?: string,
  logger: Logger = consoleLogger,
  extraArgs: string[] = [],
  timeoutMs: number = CONFIG.agentTimeoutMs
): Promise<InvokeCodexResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bye-bye-flag-codex-'));
  const schemaPath = path.join(tmpDir, 'agent-output.schema.json');
  const lastMessagePath = path.join(tmpDir, 'last-message.txt');
  const shellInit = await getShellInit(reposDir, repoName, configPath);

  try {
    await fs.writeFile(schemaPath, JSON.stringify(buildAgentOutputJsonSchema(), null, 2), 'utf-8');

    const args: string[] = [
      'exec',
      '--skip-git-repo-check',
      '-C',
      worktreePath,
      '--json',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      lastMessagePath,
    ];

    if (shouldAddFullAuto(extraArgs)) {
      args.push('--full-auto');
    }

    args.push(...extraArgs);

    // Read the prompt from stdin to avoid argv length limits.
    args.push('-');

    logger.log('--- Codex Output ---');
    const result = await runCodexExec(args, worktreePath, prompt, timeoutMs, shellInit, logger);
    logger.log('--- End Codex Output ---');
    logger.log(`Codex exit code: ${result.exitCode}`);

    if (result.timedOut) {
      throw new Error('Codex session timed out');
    }

    let lastMessage = '';
    try {
      lastMessage = await fs.readFile(lastMessagePath, 'utf-8');
    } catch {
      // If Codex failed before writing the file, we'll fall back to parsing stdout.
    }

    const raw = lastMessage.trim() ? lastMessage : result.stdout;

    // Best case: Codex outputs strict JSON matching our schema.
    try {
      const parsed = JSON.parse(raw.trim());
      const output = AgentOutputSchema.parse(parsed);
      return { output, sessionId: result.sessionId };
    } catch {
      // Fall back to parsing from text (delimiter/code-fence/raw-JSON heuristics).
      const parsed = parseAgentOutputFromText(raw);
      if (parsed) return { output: parsed, sessionId: result.sessionId };
    }

    const preview = raw.length > 800 ? raw.slice(0, 800) + '\n… (truncated)' : raw;
    throw new Error(`Failed to parse Codex output as AgentOutput.\n\nOutput preview:\n${preview}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
