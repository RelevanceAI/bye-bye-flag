import { describe, it, expect } from 'vitest';
import { generatePrompt } from './prompt.ts';

describe('generatePrompt', () => {
  it('substitutes flag key and keep branch', async () => {
    const prompt = await generatePrompt({
      flagKey: 'my-feature-flag',
      keepBranch: 'enabled',
    });
    expect(prompt).toContain('my-feature-flag');
    expect(prompt).toContain('enabled');
    expect(prompt).toContain('disabled'); // the removeBranch
  });

  it('generates camelCase and SCREAMING_SNAKE_CASE variations', async () => {
    const prompt = await generatePrompt({
      flagKey: 'my-feature-flag',
      keepBranch: 'enabled',
    });
    expect(prompt).toContain('myFeatureFlag');
    expect(prompt).toContain('MY_FEATURE_FLAG');
  });

  it('handles underscore-delimited flag keys', async () => {
    const prompt = await generatePrompt({
      flagKey: 'my_feature_flag',
      keepBranch: 'disabled',
    });
    expect(prompt).toContain('myFeatureFlag');
    expect(prompt).toContain('MY_FEATURE_FLAG');
  });

  it('includes global context when provided', async () => {
    const prompt = await generatePrompt({
      flagKey: 'test-flag',
      keepBranch: 'enabled',
      globalContext: 'This is a monorepo with two services.',
    });
    expect(prompt).toContain('This is a monorepo with two services.');
  });

  it('includes repo context when provided', async () => {
    const prompt = await generatePrompt({
      flagKey: 'test-flag',
      keepBranch: 'enabled',
      repoContext: 'Uses React and Next.js.',
    });
    expect(prompt).toContain('Uses React and Next.js.');
  });
});
