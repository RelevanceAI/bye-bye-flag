/**
 * Log file management for orchestrator
 *
 * Creates and manages log files for each flag being processed.
 * Log files are named with status suffix: .running.log, .complete.log, .failed.log, .skipped.log
 */

import * as fs from 'fs/promises';
import { createWriteStream, type WriteStream } from 'fs';
import * as path from 'path';

export type LogStatus = 'running' | 'complete' | 'failed' | 'skipped';

export interface FlagLogger {
  /**
   * Write a line to the log
   */
  log(message: string): void;

  /**
   * Write an error line to the log
   */
  error(message: string): void;

  /**
   * Get the writable stream (for piping subprocess output)
   */
  stream: WriteStream;

  /**
   * Close the log and rename to final status
   */
  finish(status: Exclude<LogStatus, 'running'>, summary?: string): Promise<void>;

  /**
   * Path to the current log file
   */
  path: string;
}

export interface RunLogger {
  /**
   * Create a logger for a specific flag
   */
  createFlagLogger(flagKey: string): Promise<FlagLogger>;

  /**
   * Write the summary file
   */
  writeSummary(summary: object): Promise<void>;

  /**
   * Path to the run directory
   */
  runDir: string;
}

/**
 * Creates a run logger for a new orchestrator run
 */
export async function createRunLogger(baseDir: string): Promise<RunLogger> {
  // Create timestamped run directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(baseDir, timestamp);
  await fs.mkdir(runDir, { recursive: true });

  const createFlagLogger = async (flagKey: string): Promise<FlagLogger> => {
    // Sanitize flag key for filename
    const safeKey = flagKey.replace(/[^a-zA-Z0-9-_]/g, '_');
    const basePath = path.join(runDir, safeKey);
    const runningPath = `${basePath}.running.log`;

    // Create the log file
    const stream = createWriteStream(runningPath, { flags: 'a' });

    // Write header
    const header = [
      `═══════════════════════════════════════════════════════════════`,
      `Flag: ${flagKey}`,
      `Started: ${new Date().toISOString()}`,
      `═══════════════════════════════════════════════════════════════`,
      '',
    ].join('\n');
    stream.write(header + '\n');

    const log = (message: string): void => {
      const line = `[${new Date().toISOString()}] ${message}\n`;
      stream.write(line);
    };

    const error = (message: string): void => {
      const line = `[${new Date().toISOString()}] ERROR: ${message}\n`;
      stream.write(line);
    };

    const finish = async (
      status: Exclude<LogStatus, 'running'>,
      summary?: string
    ): Promise<void> => {
      // Write footer
      const footer = [
        '',
        `═══════════════════════════════════════════════════════════════`,
        `Status: ${status.toUpperCase()}`,
        `Finished: ${new Date().toISOString()}`,
        summary ? `Summary: ${summary}` : '',
        `═══════════════════════════════════════════════════════════════`,
      ]
        .filter(Boolean)
        .join('\n');
      stream.write(footer + '\n');

      // Close the stream
      await new Promise<void>((resolve, reject) => {
        stream.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Rename to final status
      const finalPath = `${basePath}.${status}.log`;
      await fs.rename(runningPath, finalPath);
    };

    return {
      log,
      error,
      stream,
      finish,
      path: runningPath,
    };
  };

  const writeSummary = async (summary: object): Promise<void> => {
    const summaryPath = path.join(runDir, 'summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  };

  return {
    createFlagLogger,
    writeSummary,
    runDir,
  };
}
