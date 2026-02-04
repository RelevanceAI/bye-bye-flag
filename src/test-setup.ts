#!/usr/bin/env node

/**
 * Test utility to validate setup commands without running the full orchestrator.
 *
 * Usage:
 *   pnpm test-setup --repos-dir=/path/to/repos
 *   pnpm test-setup --repos-dir=/path/to/repos --repo=relevance-api-node
 */

import { parseArgs } from 'node:util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execa } from 'execa';
import { CONFIG } from './config.ts';
import { getDefaultBranch, readConfig, type ByeByeFlagConfig } from './agent/scaffold.ts';
import { loadEnvFileIfExists } from './env.ts';

async function runCommand(cmd: string, cwd: string, shellInit?: string): Promise<boolean> {
  const shellPrefix = shellInit ? `${shellInit} && ` : '';
  const fullCmd = `${shellPrefix}${cmd}`;

  console.log(`\n  $ ${cmd}`);
  console.log(`    cwd: ${cwd}`);

  try {
    await execa('bash', ['-c', fullCmd], {
      cwd,
      stdio: 'inherit',
    });
    console.log(`    ✓ Success`);
    return true;
  } catch (error) {
    console.log(`    ✗ Failed`);
    return false;
  }
}

async function testRepo(
  reposDir: string,
  repoName: string,
  config: ByeByeFlagConfig,
  options: { skipMainSetup?: boolean; skipWorktree?: boolean }
): Promise<boolean> {
  const repoConfig = config.repos[repoName];
  if (!repoConfig) {
    console.error(`No config for repo: ${repoName}`);
    return false;
  }

  const repoPath = path.join(reposDir, repoName);
  const shellInit = repoConfig.shellInit ?? config.shellInit;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Testing: ${repoName}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`Repo path: ${repoPath}`);
  console.log(`Shell init: ${shellInit || '(none)'}`);

  // Test mainSetup on the main repo
  if (!options.skipMainSetup && repoConfig.mainSetup && repoConfig.mainSetup.length > 0) {
    console.log(`\n--- Main Setup (on ${repoPath}) ---`);
    for (const cmd of repoConfig.mainSetup) {
      const success = await runCommand(cmd, repoPath, shellInit);
      if (!success) {
        console.error(`\nMain setup failed. Fix the command and try again.`);
        return false;
      }
    }
  }

  if (options.skipWorktree) {
    console.log(`\n--- Skipping worktree setup ---`);
    return true;
  }

  // Create a test worktree
  const testBranch = 'test-setup-' + Date.now();
  const worktreePath = path.join(CONFIG.worktreeBasePath, testBranch, repoName);

  console.log(`\n--- Creating test worktree ---`);
  console.log(`  Branch: ${testBranch}`);
  console.log(`  Path: ${worktreePath}`);

  try {
    const defaultBranch = await getDefaultBranch(repoPath);

    // Create worktree
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await execa('git', ['worktree', 'add', '-b', testBranch, worktreePath, `origin/${defaultBranch}`], {
      cwd: repoPath,
      stdio: 'inherit',
    });

    // Run setup commands
    console.log(`\n--- Setup Commands (on ${worktreePath}) ---`);
    const mainRepoPath = path.resolve(reposDir, repoName);

    for (let cmd of repoConfig.setup) {
      // Substitute ${MAIN_REPO}
      cmd = cmd.replace(/\$\{MAIN_REPO\}/g, mainRepoPath);

      const success = await runCommand(cmd, worktreePath, shellInit);
      if (!success) {
        console.error(`\nSetup command failed. Worktree left at: ${worktreePath}`);
        console.log(`\nTo inspect: cd ${worktreePath}`);
        console.log(`To cleanup: git -C ${repoPath} worktree remove ${worktreePath} --force`);
        return false;
      }
    }

    console.log(`\n--- All setup commands passed! ---`);

    // Cleanup
    console.log(`\nCleaning up test worktree...`);
    await execa('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
    await execa('git', ['branch', '-D', testBranch], { cwd: repoPath, reject: false });

    return true;
  } catch (error) {
    console.error(`\nError creating/testing worktree:`, error);
    return false;
  }
}

async function main() {
  loadEnvFileIfExists('.env');
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  const { values } = parseArgs({
    args,
    options: {
      'repos-dir': { type: 'string' },
      'repo': { type: 'string' },
      'skip-main-setup': { type: 'boolean', default: false },
      'skip-worktree': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || !values['repos-dir']) {
    console.log(`
Test setup commands for bye-bye-flag

Usage:
  pnpm test-setup --repos-dir=/path/to/repos [options]

Options:
  --repos-dir=<path>    Path to directory containing bye-bye-flag-config.json (required)
  --repo=<name>         Test only this repo (default: test all)
  --skip-main-setup     Skip mainSetup commands (test only worktree setup)
  --skip-worktree       Skip worktree creation (test only mainSetup)
  -h, --help            Show this help

Examples:
  # Test all repos
  pnpm test-setup --repos-dir=.target-repos

  # Test only relevance-api-node
  pnpm test-setup --repos-dir=.target-repos --repo=relevance-api-node

  # Test only worktree setup (assume mainSetup already done)
  pnpm test-setup --repos-dir=.target-repos --skip-main-setup
`);
    process.exit(values.help ? 0 : 1);
  }

  const reposDir = values['repos-dir'];
  const config = await readConfig(reposDir);
  const repoNames = values.repo ? [values.repo] : Object.keys(config.repos);

  console.log(`\nTesting setup for ${repoNames.length} repo(s)...`);

  let allPassed = true;
  for (const repoName of repoNames) {
    const passed = await testRepo(reposDir, repoName, config, {
      skipMainSetup: values['skip-main-setup'],
      skipWorktree: values['skip-worktree'],
    });
    if (!passed) {
      allPassed = false;
      break; // Stop on first failure
    }
  }

  if (allPassed) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`All setup tests passed!`);
    console.log(`${'═'.repeat(60)}\n`);
  } else {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
