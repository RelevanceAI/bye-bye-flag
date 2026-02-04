export function loadEnvFileIfExists(envFilePath: string = '.env'): void {
  const loadEnvFile = (process as NodeJS.Process & { loadEnvFile?: (path?: string) => void })
    .loadEnvFile;

  if (typeof loadEnvFile !== 'function') return;

  try {
    loadEnvFile(envFilePath);
  } catch (error) {
    // Missing .env is fine (equivalent to --env-file-if-exists).
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return;

    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[bye-bye-flag] Warning: Failed to load ${envFilePath}: ${message}`);
  }
}
