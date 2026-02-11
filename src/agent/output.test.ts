import { describe, it, expect } from 'vitest';
import { parseAgentOutputFromText, parseDelimitedAgentOutput, RESULT_DELIMITER } from './output.ts';

const validOutput = {
  status: 'success' as const,
  summary: 'Removed flag from 2 files',
  filesChanged: ['src/app.ts', 'src/config.ts'],
  testsPass: true,
  lintPass: true,
  typecheckPass: true,
};

describe('parseDelimitedAgentOutput', () => {
  it('parses output after delimiter', () => {
    const text = `Some agent chatter\n${RESULT_DELIMITER}\n${JSON.stringify(validOutput)}`;
    const result = parseDelimitedAgentOutput(text);
    expect(result).toEqual(validOutput);
  });

  it('parses output in a code fence after delimiter', () => {
    const text = `Done!\n${RESULT_DELIMITER}\n\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``;
    const result = parseDelimitedAgentOutput(text);
    expect(result).toEqual(validOutput);
  });

  it('throws if delimiter is missing', () => {
    expect(() => parseDelimitedAgentOutput('no delimiter here')).toThrow();
  });

  it('throws if JSON after delimiter is invalid', () => {
    const text = `${RESULT_DELIMITER}\n{invalid json}`;
    expect(() => parseDelimitedAgentOutput(text)).toThrow();
  });
});

describe('parseAgentOutputFromText', () => {
  it('prefers delimiter when present', () => {
    const text = `Agent output\n${RESULT_DELIMITER}\n${JSON.stringify(validOutput)}`;
    const result = parseAgentOutputFromText(text);
    expect(result).toEqual(validOutput);
  });

  it('extracts from JSON code fence', () => {
    const text = `I made changes.\n\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\`\nDone.`;
    const result = parseAgentOutputFromText(text);
    expect(result).toEqual(validOutput);
  });

  it('extracts raw JSON object from end of text', () => {
    const text = `Agent did stuff.\n${JSON.stringify(validOutput)}`;
    const result = parseAgentOutputFromText(text);
    expect(result).toEqual(validOutput);
  });

  it('returns null for text with no JSON', () => {
    const result = parseAgentOutputFromText('Just some text with no JSON at all');
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON that does not match schema', () => {
    const result = parseAgentOutputFromText('{ "foo": "bar" }');
    expect(result).toBeNull();
  });

  it('handles refused status', () => {
    const refused = {
      status: 'refused',
      summary: 'Flag not found in codebase',
      filesChanged: [],
      testsPass: true,
      lintPass: true,
      typecheckPass: true,
    };
    const text = `${RESULT_DELIMITER}\n${JSON.stringify(refused)}`;
    const result = parseAgentOutputFromText(text);
    expect(result?.status).toBe('refused');
  });

  it('prefers the last code fence', () => {
    const wrong = { ...validOutput, summary: 'wrong' };
    const text =
      `\`\`\`json\n${JSON.stringify(wrong)}\n\`\`\`\n` + `\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``;
    const result = parseAgentOutputFromText(text);
    expect(result?.summary).toBe('Removed flag from 2 files');
  });
});
