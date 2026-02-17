import { describe, expect, it } from 'vitest';
import { stripArgPairOrInline } from '../adapters.ts';

describe('stripArgPairOrInline', () => {
  it('removes session arg and value pair', () => {
    const args = ['--dangerously-skip-permissions', '--session-id', 'abc-123', '-p', 'prompt'];
    const result = stripArgPairOrInline(args, '--session-id', 'abc-123');

    expect(result).toEqual(['--dangerously-skip-permissions', '-p', 'prompt']);
    expect(args).toEqual(['--dangerously-skip-permissions', '--session-id', 'abc-123', '-p', 'prompt']);
  });

  it('removes inline session arg when value matches', () => {
    const args = ['--session-id=abc-123', '--dangerously-skip-permissions'];
    const result = stripArgPairOrInline(args, '--session-id', 'abc-123');

    expect(result).toEqual(['--dangerously-skip-permissions']);
  });

  it('does not remove unrelated args', () => {
    const args = ['exec', '--full-auto', '-', '--session-id=other'];
    const result = stripArgPairOrInline(args, '--session-id', 'abc-123');

    expect(result).toEqual(args);
  });
});
