import { AgentOutputSchema, type AgentOutput } from '../types.ts';

export const RESULT_DELIMITER = '---RESULT---';

/**
 * Parse a structured AgentOutput from a blob of assistant text.
 *
 * Fast paths:
 * - A trailing `---RESULT---` delimiter followed by JSON
 * - A JSON code fence
 * - A raw JSON object near the end of the text
 */
export function parseAgentOutputFromText(text: string): AgentOutput | null {
  // Prefer explicit delimiter if present (most reliable).
  if (text.includes(RESULT_DELIMITER)) {
    try {
      return parseDelimitedAgentOutput(text);
    } catch {
      // Fall through to heuristic parsing
    }
  }

  return tryParseAgentOutputFromText(text);
}

export function parseDelimitedAgentOutput(text: string): AgentOutput {
  const delimiterIndex = text.lastIndexOf(RESULT_DELIMITER);

  if (delimiterIndex === -1) {
    throw new Error(`Could not find ${RESULT_DELIMITER} in text.`);
  }

  const jsonPart = text.slice(delimiterIndex + RESULT_DELIMITER.length).trim();

  // Extract JSON from potential markdown code block
  let jsonString = jsonPart;
  const jsonMatch = jsonPart.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonString = jsonMatch[1].trim();
  }

  const parsed = JSON.parse(jsonString);
  return AgentOutputSchema.parse(parsed);
}

export function tryParseAgentOutputFromText(text: string): AgentOutput | null {
  // 1) Prefer JSON fenced blocks if present (common)
  const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of codeBlocks.reverse()) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      return AgentOutputSchema.parse(parsed);
    } catch {
      // Keep trying
    }
  }

  // 2) Heuristic: scan backwards for a JSON object and validate against our schema.
  const lastClose = text.lastIndexOf('}');
  if (lastClose === -1) return null;

  let start = text.lastIndexOf('{', lastClose);
  let attempts = 0;
  while (start !== -1 && attempts < 25) {
    const candidate = text.slice(start, lastClose + 1).trim();
    try {
      const parsed = JSON.parse(candidate);
      return AgentOutputSchema.parse(parsed);
    } catch {
      // Try an earlier '{'
    }
    attempts++;
    start = text.lastIndexOf('{', start - 1);
  }

  return null;
}
