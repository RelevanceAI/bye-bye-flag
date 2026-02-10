# Feature Flag Removal Task

You are removing a feature flag from this codebase. Each subdirectory in your current working directory is an independent git repository. The flag may exist in one or more of them.

## Flag Details
- **Flag key:** `{{flagKey}}`
- **Keep branch:** `{{keepBranch}}` (remove the `{{removeBranch}}` code path)

## Repository Context
{{repoContext}}

## Available Tools

You have access to `git` and `gh` (GitHub CLI). Use them if helpful:
- `git log --all --oneline --grep="{{flagKey}}"` - find commits that added/modified the flag
- `gh pr list --search "{{flagKey}}"` - find related PRs
- `gh pr view <number>` - view PR details, description, and discussion

Use your judgment: for simple flags, just remove them. For complex flags or when the code seems to have related parts that aren't obvious, checking the history can help you find associated code (analytics, logging, config) that should also be cleaned up.

## Instructions

### Step 1: Find all usages

Search for the flag key in the codebase. Look for variations:
- Exact match: `"{{flagKey}}"`
- camelCase: `"{{flagKeyCamel}}"`
- SCREAMING_SNAKE_CASE: `"{{flagKeyScreaming}}"`

Common patterns to look for:
- `isFeatureEnabled('{{flagKey}}')`
- `useFeatureFlag('{{flagKey}}')`
- `featureFlags.{{flagKeyCamel}}`
- Environment variables or config files

Note: The flag has been verified to exist in the codebase before you were launched.

### Step 2: Remove the flag

For each usage:
- Remove the conditional check entirely
- Keep the `{{keepBranch}}` code path
- Remove the `{{removeBranch}}` code path

Example transformation (keeping `enabled` branch):
```typescript
// Before
if (isFeatureEnabled('my-flag')) {
  doNewThing();
} else {
  doOldThing();
}

// After
doNewThing();
```

Example transformation (keeping `disabled` branch):
```typescript
// Before
if (isFeatureEnabled('my-flag')) {
  doNewThing();
} else {
  doOldThing();
}

// After
doOldThing();
```

### Step 3: Clean up dead code

After removing the flag checks:
- Remove any unused imports
- Remove any unused type definitions
- Remove any unused functions, components, or files that were only used in the removed branch
- Remove any test files that only tested the removed code path
- Do NOT remove code that is still used elsewhere

Be thorough but careful. Trace the dependencies of removed code.

### Step 4: Verify changes

Run the following commands and fix any issues:
1. **Typecheck** (if available): Look for a typecheck script in package.json
2. **Lint** (if available): Look for a lint script in package.json
3. **Tests** (if available): Look for a test script in package.json

If any of these fail due to your changes, fix them.
If they fail for unrelated reasons (pre-existing issues), note this in your summary but continue.

### Step 5: Output result

After completing all steps, provide your normal human-readable summary.

Then, **best-effort**, append a machine-readable result block in the format below. This helps the caller parse results reliably.
If you forget (long/complex tasks sometimes cause context rot), that's okay — the caller will fall back to normalizing your output.

1) Print this delimiter on its own line: `---RESULT---`

2) Immediately after, print a single JSON object (no markdown fences):

{
  "status": "success" | "refused",
  "summary": "brief description of what was done (or why you refused)",
  "filesChanged": ["array", "of", "file", "paths"],
  "testsPass": true/false,
  "lintPass": true/false,
  "typecheckPass": true/false,
  "verificationDetails": {
    "tests": "optional brief failure detail (only when testsPass=false)",
    "lint": "optional brief failure detail (only when lintPass=false)",
    "typecheck": "optional brief failure detail (only when typecheckPass=false)"
  }
}

Rules:
- If tests/lint/typecheck were skipped or not run, set them to `true`.
- Only include `verificationDetails` entries for checks that failed.
- If you refuse (e.g. flag not found / too risky), use `"status": "refused"` and explain in `summary`.

## Important Rules

1. **Only modify code related to this flag removal** - do not refactor unrelated code
2. **Do not add new features** - this is a removal task only
3. **Be thorough with cleanup** - don't leave dead code behind
4. **Preserve functionality** - the app should work exactly as if the flag was always `{{keepBranch}}`
5. **If unsure, refuse** - it's better to refuse than to break the codebase
