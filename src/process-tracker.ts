/**
 * Track child processes for cleanup on exit
 */

import type { ChildProcess } from 'child_process';

const childProcesses = new Set<ChildProcess>();

export function registerChildProcess(child: ChildProcess): void {
  childProcesses.add(child);
  child.on('exit', () => childProcesses.delete(child));
}

export function killAllChildren(): void {
  for (const child of childProcesses) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }
  }
}

/**
 * Setup signal handlers for clean shutdown
 * Call this once at startup
 */
export function setupSignalHandlers(): void {
  const cleanup = (signal: NodeJS.Signals) => {
    const exitCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };
    console.log(`\n\nReceived ${signal}, shutting down...`);
    killAllChildren();

    // Give children a moment to exit, then force exit
    setTimeout(() => {
      process.exit(exitCodes[signal] ?? 128);
    }, 1000);
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
}
