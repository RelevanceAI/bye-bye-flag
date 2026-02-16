import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { fetchAllFlagPRs, findExistingPR } from '../git.ts';

describe('PR discovery safety rules', () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it('treats a flag as OPEN when any historical PR is open', async () => {
    execaMock.mockResolvedValue({
      stdout: JSON.stringify([
        {
          url: 'https://example.com/pr/closed-newer',
          state: 'CLOSED',
          title: 'bye-bye-flag: Remove `foo`',
          headRefName: 'remove-flag/foo',
          createdAt: '2026-02-11T00:00:00Z',
        },
        {
          url: 'https://example.com/pr/open-older',
          state: 'OPEN',
          title: 'bye-bye-flag: Remove `foo`',
          headRefName: 'remove-flag/foo',
          createdAt: '2026-02-10T00:00:00Z',
        },
      ]),
    });

    const prs = await fetchAllFlagPRs('/tmp/repo');
    const foo = prs.get('foo');

    expect(foo).toBeDefined();
    expect(foo?.state).toBe('OPEN');
    expect(foo?.declined).toBe(false);
    expect(foo?.url).toBe('https://example.com/pr/open-older');
    expect(foo?.history).toHaveLength(2);
  });

  it('treats a flag as DECLINED when any historical PR is declined', async () => {
    execaMock.mockResolvedValue({
      stdout: JSON.stringify([
        {
          url: 'https://example.com/pr/open',
          state: 'OPEN',
          title: 'bye-bye-flag: Remove `foo`',
          headRefName: 'remove-flag/foo',
          createdAt: '2026-02-11T00:00:00Z',
        },
        {
          url: 'https://example.com/pr/declined',
          state: 'CLOSED',
          title: '[DECLINED] bye-bye-flag: Remove `foo`',
          headRefName: 'remove-flag/foo',
          createdAt: '2026-02-10T00:00:00Z',
        },
      ]),
    });

    const prs = await fetchAllFlagPRs('/tmp/repo');
    const foo = prs.get('foo');

    expect(foo).toBeDefined();
    expect(foo?.declined).toBe(true);
    expect(foo?.url).toBe('https://example.com/pr/declined');
  });

  it('findExistingPR queries by head branch and returns safety state', async () => {
    execaMock.mockResolvedValue({
      stdout: JSON.stringify([
        {
          url: 'https://example.com/pr/open',
          state: 'OPEN',
          title: 'bye-bye-flag: Remove `foo`',
          headRefName: 'remove-flag/foo',
          createdAt: '2026-02-11T00:00:00Z',
        },
      ]),
    });

    const existing = await findExistingPR('/tmp/repo', 'foo');

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock.mock.calls[0]?.[1]).toContain('--head');
    expect(execaMock.mock.calls[0]?.[1]).toContain('remove-flag/foo');
    expect(existing?.state).toBe('OPEN');
  });

  it('throws when PR discovery fails', async () => {
    execaMock.mockRejectedValue(new Error('gh unavailable'));

    await expect(fetchAllFlagPRs('/tmp/repo')).rejects.toThrow('Failed to fetch PRs');
    await expect(findExistingPR('/tmp/repo', 'foo')).rejects.toThrow('Failed to discover existing PRs');
  });
});
