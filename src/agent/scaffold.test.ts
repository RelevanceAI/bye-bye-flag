import { describe, it, expect } from 'vitest';
import { getRepoBaseBranch, type ByeByeFlagConfig } from './scaffold.ts';

describe('getRepoBaseBranch', () => {
  it('returns per-repo baseBranch when set', () => {
    const config: ByeByeFlagConfig = {
      repos: {
        'my-repo': { baseBranch: 'develop', setup: ['pnpm install'] },
      },
      repoDefaults: { baseBranch: 'main' },
    };
    expect(getRepoBaseBranch(config, 'my-repo')).toBe('develop');
  });

  it('falls back to repoDefaults.baseBranch', () => {
    const config: ByeByeFlagConfig = {
      repos: {
        'my-repo': { setup: ['pnpm install'] },
      },
      repoDefaults: { baseBranch: 'main', setup: ['pnpm install'] },
    };
    expect(getRepoBaseBranch(config, 'my-repo')).toBe('main');
  });

  it('throws for unknown repo', () => {
    const config: ByeByeFlagConfig = {
      repos: {
        'my-repo': { baseBranch: 'main', setup: ['pnpm install'] },
      },
    };
    expect(() => getRepoBaseBranch(config, 'unknown')).toThrow('No config entry');
  });

  it('throws when baseBranch is missing entirely', () => {
    const config: ByeByeFlagConfig = {
      repos: {
        'my-repo': { setup: ['pnpm install'] },
      },
    };
    expect(() => getRepoBaseBranch(config, 'my-repo')).toThrow('Missing baseBranch');
  });
});
