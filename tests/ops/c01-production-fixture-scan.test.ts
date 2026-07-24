import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * C01 production fixture scan gate.
 *
 * Ensures that no hard-coded fixture UUIDs or fixture default values
 * leak into the production web pages (Server Components under apps/web/src/app/app/).
 *
 * Fake-mode stores (in-memory-*, fake-*) are excluded from this scan
 * because they are only loaded when AEOSTUDIO_AUTH_MODE=fake.
 */

const WEB_APP_PAGES_DIR = join(import.meta.dirname, '../../apps/web/src/app/app');

const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /00000000-0000-7000-8000-[0-9a-f]{12}/g,
    label: 'hard-coded fixture UUID (00000000-0000-7000-8000-*)',
  },
  {
    pattern: /\bFIXTURES\b/g,
    label: 'FIXTURES constant reference',
  },
  {
    pattern: /FAKE_APPROVED_BRIEF_ID/g,
    label: 'FAKE_APPROVED_BRIEF_ID constant',
  },
  {
    pattern: /fixture-search-model/g,
    label: 'fixture-search-model default value',
  },
  {
    pattern: /workspace-fixture-account/g,
    label: 'workspace-fixture-account default value',
  },
];

function collectTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectTsxFiles(full));
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('C01 production fixture scan gate', () => {
  it('web app pages contain no hard-coded fixture UUIDs or fixture constants', () => {
    const files = collectTsxFiles(WEB_APP_PAGES_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      for (const { pattern, label } of FORBIDDEN_PATTERNS) {
        const matches = content.match(pattern);
        if (matches !== null) {
          violations.push(`${file}: ${label} (${matches.length} occurrence(s))`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('production API controllers do not embed fixture UUIDs', () => {
    const controllersDir = join(import.meta.dirname, '../../apps/api/src');
    const files = collectTsxFiles(controllersDir).filter(
      (f) =>
        f.endsWith('.controller.ts') &&
        !f.includes('in-memory') &&
        !f.includes('fake') &&
        !f.includes('missing'),
    );
    expect(files.length).toBeGreaterThan(0);

    const uuidPattern = /00000000-0000-7000-8000-[0-9a-f]{12}/g;
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const matches = content.match(uuidPattern);
      if (matches !== null) {
        violations.push(`${file}: fixture UUID (${matches.length} occurrence(s))`);
      }
    }

    expect(violations).toEqual([]);
  });
});
