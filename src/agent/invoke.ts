import { spawn } from 'child_process';
import { v5 as uuidv5 } from 'uuid';
import { CONFIG } from '../config.ts';
import { AgentOutputSchema, consoleLogger, type AgentOutput, type Logger } from '../types.ts';
import { getShellInit } from './scaffold.ts';
import { registerChildProcess } from '../process-tracker.ts';

const RESULT_DELIMITER = '---RESULT---';
const MAX_RETRIES = 2;

/**
 * Generates a unique session ID from the branch name + timestamp
 * Each invocation gets a new session to avoid conflicts
 */
export function getSessionId(branchName: string): string {
  const uniqueKey = `${branchName}-${Date.now()}`;
  return uuidv5(uniqueKey, CONFIG.sessionNamespace);
}

interface RunResult {
  stdout: string;
  timedOut: boolean;
  exitCode: number | null;
}

/**
 * Parses streaming JSON events and displays progress
 */
function processStreamEvent(line: string, logger: Logger): void {
  if (!line.trim()) return;

  try {
    const event = JSON.parse(line);

    // Handle different event types
    switch (event.type) {
      case 'assistant':
        // Assistant message with text or tool use
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              logger.log(`[Claude] ${block.text}`);
            } else if (block.type === 'tool_use') {
              logger.log(`[Tool] ${block.name}: ${JSON.stringify(block.input).slice(0, 100)}...`);
            }
          }
        }
        break;

      case 'user':
        // Tool results
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_result') {
              const preview = typeof block.content === 'string'
                ? block.content.slice(0, 100)
                : JSON.stringify(block.content).slice(0, 100);
              logger.log(`[Result] ${preview}...`);
            }
          }
        }
        break;

      case 'result':
        logger.log(`[Done] Cost: $${event.cost_usd?.toFixed(4) || 'N/A'}, Duration: ${event.duration_ms}ms`);
        break;

      default:
        // Skip other event types (system, etc.)
        break;
    }
  } catch {
    // Not valid JSON or parsing error, skip
  }
}

/**
 * Runs Claude Code with the given arguments, handling streaming and timeout
 */
function runClaudeCode(
  args: string[],
  cwd: string,
  timeout: number,
  shellInit: string | undefined,
  logger: Logger
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let lineBuffer = '';
    let timedOut = false;

    // Build command with optional shell init
    const quotedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const shellPrefix = shellInit ? `${shellInit} && ` : '';
    const child = spawn('bash', ['-c', `${shellPrefix}claude ${quotedArgs}`], {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Register for cleanup on Ctrl+C
    registerChildProcess(child);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      lineBuffer += text;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        processStreamEvent(line, logger);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(chunk.toString().trimEnd());
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (lineBuffer.trim()) {
        processStreamEvent(lineBuffer, logger);
      }

      resolve({ stdout, timedOut, exitCode: code });
    });

    child.on('error', () => {
      clearTimeout(timeoutHandle);
      resolve({ stdout, timedOut: false, exitCode: 1 });
    });
  });
}

/**
 * Invokes Claude Code with the given prompt and parses the result
 * Uses stream-json output for real-time progress visibility
 * Automatically retries with --resume if it times out
 */
export async function invokeClaudeCode(
  worktreePath: string,
  branchName: string,
  prompt: string,
  reposDir: string,
  repoName?: string, // For single-repo mode, to get repo-specific shellInit
  providedSessionId?: string, // Optional: use existing session ID (for resume)
  logger: Logger = consoleLogger // Optional logger (defaults to console)
): Promise<AgentOutput> {
  const sessionId = providedSessionId || getSessionId(branchName);
  const shellInit = await getShellInit(reposDir, repoName);

  logger.log(`Invoking Claude Code (session: ${sessionId.slice(0, 8)}...)...`);
  logger.log(`Working directory: ${worktreePath}`);
  logger.log(`Prompt length: ${prompt.length} characters`);
  logger.log('--- Claude Code Output ---');

  // Initial run
  const initialArgs = [
    '--session-id', sessionId,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '-p', prompt,
  ];

  let result = await runClaudeCode(initialArgs, worktreePath, CONFIG.claudeTimeout, shellInit, logger);
  let retries = 0;

  // Retry with --resume if timed out
  while (result.timedOut && retries < MAX_RETRIES) {
    retries++;
    logger.log(`[Timeout] Resuming session (attempt ${retries}/${MAX_RETRIES})...`);

    const resumePrompt = retries === MAX_RETRIES
      ? 'You are running out of time. Stop what you are doing immediately and provide a summary of what you have completed so far. List all files you have modified.'
      : 'Continue where you left off. If you are close to finishing, wrap up and provide a summary.';

    const resumeArgs = [
      '--resume', sessionId,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', resumePrompt,
    ];

    const resumeResult = await runClaudeCode(resumeArgs, worktreePath, CONFIG.claudeTimeout, shellInit, logger);
    result = {
      stdout: result.stdout + resumeResult.stdout,
      timedOut: resumeResult.timedOut,
      exitCode: resumeResult.exitCode,
    };
  }

  logger.log('--- End Claude Code Output ---');
  logger.log(`Claude Code exit code: ${result.exitCode}`);

  if (result.timedOut) {
    logger.log('[Warning] Session timed out after all retries, attempting to parse partial output...');
  }

  if (!result.stdout || result.stdout.length === 0) {
    throw new Error('Claude Code produced no output');
  }

  return parseStreamOutput(result.stdout, worktreePath, logger);
}

/**
 * Resumes a previous Claude Code session (not typically used - invokeClaudeCode handles retries internally)
 */
export async function resumeClaudeCode(
  worktreePath: string,
  sessionId: string,
  additionalPrompt?: string,
  logger: Logger = consoleLogger
): Promise<AgentOutput> {
  logger.log(`Resuming Claude Code session (${sessionId.slice(0, 8)}...)...`);
  logger.log('--- Claude Code Output ---');

  const args = [
    '--resume', sessionId,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (additionalPrompt) {
    args.push('-p', additionalPrompt);
  }

  const result = await runClaudeCode(args, worktreePath, CONFIG.claudeTimeout, undefined, logger);

  logger.log('--- End Claude Code Output ---');

  if (!result.stdout || result.stdout.length === 0) {
    throw new Error('Claude Code produced no output');
  }

  return parseStreamOutput(result.stdout, worktreePath, logger);
}

/**
 * Extracts all assistant text from stream-json output
 */
function extractAssistantText(stdout: string): { text: string; hasResult: boolean } {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let allAssistantText = '';
  let hasResult = false;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === 'result') {
        hasResult = true;
      }

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            allAssistantText += block.text + '\n';
          }
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return { text: allAssistantText, hasResult };
}

/**
 * Uses a quick Claude call to normalize any output format to our expected JSON
 */
async function normalizeOutput(rawOutput: string, cwd: string, logger: Logger): Promise<AgentOutput> {
  logger.log('Normalizing output format...');

  const normalizePrompt = `Convert the following feature flag removal output to this exact JSON format. Output ONLY the JSON, no other text:

{
  "status": "success" or "refused",
  "summary": "brief description of what was done",
  "filesChanged": ["array", "of", "file", "paths"],
  "testsPass": true/false,
  "lintPass": true/false,
  "typecheckPass": true/false
}

If tests/lint/typecheck were skipped or not run, set them to true.
If the task was refused (e.g., flag not found), use status "refused".

Here is the output to convert (may be truncated in the middle if very long):

${rawOutput.length > 12000
    ? rawOutput.slice(0, 4000) + '\n\n[... truncated middle section ...]\n\n' + rawOutput.slice(-8000)
    : rawOutput}`;

  return new Promise((resolve, reject) => {
    let stdout = '';

    const child = spawn(
      'claude',
      [
        '--dangerously-skip-permissions',
        '--output-format',
        'json',
        '-p',
        normalizePrompt,
      ],
      {
        cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
      }
    );

    // Register for cleanup on Ctrl+C
    registerChildProcess(child);

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Normalize call timed out'));
    }, 60000); // 1 minute should be plenty

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(chunk.toString().trimEnd());
    });

    child.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0 || !stdout) {
        reject(new Error(`Normalize call failed with code ${code}`));
        return;
      }

      try {
        // Parse the JSON output (--output-format json gives us a wrapper)
        const wrapper = JSON.parse(stdout);
        const resultText = wrapper.result || stdout;

        // Extract JSON from the result
        let jsonStr = resultText;
        const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          jsonStr = jsonMatch[1];
        }

        const parsed = JSON.parse(jsonStr.trim());
        resolve(AgentOutputSchema.parse(parsed));
      } catch (error) {
        reject(new Error(`Failed to parse normalized output: ${error}\n\nRaw: ${stdout.slice(0, 500)}`));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Parses the stream-json output to extract the final result
 * Uses a follow-up Claude call to normalize the output format
 */
async function parseStreamOutput(stdout: string, cwd: string, logger: Logger): Promise<AgentOutput> {
  const { text, hasResult } = extractAssistantText(stdout);

  if (!hasResult) {
    throw new Error(
      `Claude Code did not complete successfully. ` +
        `The agent may have been interrupted.`
    );
  }

  // Try to find our expected format first (fast path)
  if (text.includes(RESULT_DELIMITER)) {
    try {
      return parseAgentOutput(text);
    } catch {
      // Fall through to normalization
    }
  }

  // Use Claude to normalize whatever format was output
  return normalizeOutput(text, cwd, logger);
}

/**
 * Parses the structured output from Claude Code's response
 */
function parseAgentOutput(text: string): AgentOutput {
  const delimiterIndex = text.lastIndexOf(RESULT_DELIMITER);

  if (delimiterIndex === -1) {
    throw new Error(
      `Could not find ${RESULT_DELIMITER} in text.`
    );
  }

  const jsonPart = text.slice(delimiterIndex + RESULT_DELIMITER.length).trim();

  // Extract JSON from potential markdown code block
  let jsonString = jsonPart;
  const jsonMatch = jsonPart.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonString = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonString);
    return AgentOutputSchema.parse(parsed);
  } catch (error) {
    throw new Error(
      `Failed to parse agent output as JSON: ${error}\n\nRaw output after delimiter:\n${jsonPart.slice(0, 500)}`
    );
  }
}
