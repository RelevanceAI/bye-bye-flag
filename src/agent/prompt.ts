import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PromptParams {
  flagKey: string;
  keepBranch: 'enabled' | 'disabled';
  repoContext?: string;
  globalContext?: string;
}

/**
 * Reads all .md files from a directory and concatenates them
 */
export async function readContextFiles(dirPath: string): Promise<string> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const mdFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')
    );

    if (mdFiles.length === 0) {
      return '';
    }

    const contents: string[] = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(dirPath, file.name), 'utf-8');
      contents.push(`## ${file.name}\n\n${content}`);
    }

    return contents.join('\n\n---\n\n');
  } catch {
    return '';
  }
}

/**
 * Generates the prompt for the configured agent to remove a feature flag
 */
export async function generatePrompt(params: PromptParams): Promise<string> {
  const { flagKey, keepBranch, repoContext, globalContext } = params;
  const removeBranch = keepBranch === 'enabled' ? 'disabled' : 'enabled';

  // Generate variations of the flag key for searching
  const flagKeyCamel = toCamelCase(flagKey);
  const flagKeyScreaming = toScreamingSnake(flagKey);

  const promptTemplate = await fs.readFile(
    path.join(__dirname, '../../prompts/remove-flag.md'),
    'utf-8'
  );

  // Build context section
  let contextSection = '';
  if (globalContext) {
    contextSection += `### Global Context (how repositories relate)\n\n${globalContext}\n\n`;
  }
  if (repoContext) {
    contextSection += `### Repository-Specific Context\n\n${repoContext}`;
  }
  if (!contextSection) {
    contextSection = 'No additional context provided. Read the README and explore the codebase.';
  }

  // Simple template replacement
  let prompt = promptTemplate
    .replace(/\{\{flagKey\}\}/g, flagKey)
    .replace(/\{\{keepBranch\}\}/g, keepBranch)
    .replace(/\{\{removeBranch\}\}/g, removeBranch)
    .replace(/\{\{flagKeyCamel\}\}/g, flagKeyCamel)
    .replace(/\{\{flagKeyScreaming\}\}/g, flagKeyScreaming)
    .replace(/\{\{repoContext\}\}/g, contextSection);

  return prompt;
}

function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toScreamingSnake(str: string): string {
  return str.replace(/-/g, '_').toUpperCase();
}
