/**
 * Guard test: verifies that no executable source code references legacy SQLite dependencies.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

// Legacy patterns to detect (stored split to avoid triggering guard on this file itself)
const SQLITE_IMPORT = ['better', '-sqlite3'].join('');
const DB_PATH_ENV = ['DB', '_PATH'].join('');
const SQLITE_EXTENSION = ['.', 'sqlite'].join('');

function findSourceFiles(dir: string, results: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (['node_modules', 'dist', '.git', 'tests'].includes(entry)) continue;
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          findSourceFiles(fullPath, results);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
          results.push(fullPath);
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return results;
}

test('No SQLite dependencies in executable TypeScript source files', () => {
  const repoRoot = join(new URL('.', import.meta.url).pathname, '../../../../..');
  const tsFiles = findSourceFiles(join(repoRoot, 'src'));
  
  const violations: string[] = [];
  for (const file of tsFiles) {
    try {
      const content = readFileSync(file, 'utf8');
      if (
        content.includes(SQLITE_IMPORT) ||
        content.includes(DB_PATH_ENV) ||
        content.includes(SQLITE_EXTENSION)
      ) {
        violations.push(file);
      }
    } catch {
      // skip unreadable files
    }
  }
  
  assert.equal(
    violations.length, 0,
    `Found legacy SQLite references in:\n${violations.join('\n')}\n\nAll SQLite dependencies must be removed.`
  );
});
