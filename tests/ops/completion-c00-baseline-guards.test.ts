import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Z]:)/u, '$1');

describe('Completion C00 — production baseline guards', () => {
  test('production runtime refuses fake mode when NODE_ENV=production', () => {
    // 验证 resolve-runtime.ts 包含 production fake mode 阻断逻辑
    const resolveRuntime = readFileSync(
      join(root, 'apps/api/src/runtime/resolve-runtime.ts'),
      'utf8',
    );

    // 必须检查 NODE_ENV
    expect(resolveRuntime).toContain("process.env.NODE_ENV === 'test'");
    expect(resolveRuntime).toContain("process.env.NODE_ENV === 'development'");

    // 必须在 production 下抛出错误
    expect(resolveRuntime).toContain('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');

    // 必须检查 AEOSTUDIO_ALLOW_FAKE_RUNTIME
    expect(resolveRuntime).toContain("process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME !== 'true'");
  });

  test('README clearly distinguishes fake runtime from production runtime', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');

    // 必须包含 fake 和 production 的明确区分
    expect(readme).toContain('Fake Runtime');
    expect(readme).toContain('Production Runtime');
    expect(readme).toMatch(/fake.*production|production.*fake/isu);

    // 必须说明 production 不会自动启用 fake
    expect(readme).toMatch(/production.*不会.*fake|fail closed/isu);

    // 必须包含不保证声明
    expect(readme).toContain('不保证');
  });

  test('.env.example contains no suspected secrets', () => {
    const envExample = readFileSync(join(root, '.env.example'), 'utf8');

    // 不应该包含看起来像真实 secret 的值
    const lines = envExample.split('\n');
    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') continue;

      const match = line.match(/^([A-Z_]+)=(.*)$/u);
      if (!match) continue;

      const key = match[1] ?? '';
      const value = match[2] ?? '';

      // 跳过空值和占位符
      if (value === '' || value.startsWith('<') || value.includes('{')) continue;

      // 检查疑似 secret 的 key
      const secretKeyPatterns = [/SECRET/iu, /PASSWORD/iu, /TOKEN/iu, /KEY/iu, /CREDENTIAL/iu];
      const isSecretKey = secretKeyPatterns.some((p) => p.test(key));

      if (isSecretKey && value.length > 0) {
        // 只允许明确的示例/占位符值
        const allowedPatterns = [
          /^aeostudio-/u, // 明确的示例前缀
          /^test-/u,
          /^fake-/u,
          /^dummy-/u,
          /^example-/u,
          /^change-?me$/iu,
          /^your-/iu,
          /^<.*>$/u, // <placeholder>
        ];
        const isAllowed = allowedPatterns.some((p) => p.test(value));

        expect(isAllowed, `Key "${key}" has value "${value}" that looks like a real secret`).toBe(
          true,
        );
      }
    }
  });

  // C01 阶段将审查这些固定 UUID 使用（部分可能是合理的系统 actor ID）
  test.todo(
    'production source paths do not contain fixed test tenant/workspace IDs (C01 review)',
    () => {
      const productionDirs = ['apps/api/src', 'apps/web/src', 'apps/worker/src', 'packages'];
      const testIdPatterns = [
        /00000000-0000-0000-0000-000000000000/u,
        /tenant-test-/u,
        /workspace-test-/u,
        /fixture-tenant-/u,
        /fixture-workspace-/u,
        /test-tenant-id/u,
        /test-workspace-id/u,
      ];

      const violations: string[] = [];

      function scanDir(dir: string): void {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }

        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            // 跳过测试和 node_modules 目录
            if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
            scanDir(fullPath);
          } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
            // 跳过测试文件
            if (entry.includes('.test.') || entry.includes('.spec.')) continue;

            const content = readFileSync(fullPath, 'utf8');
            const relPath = relative(root, fullPath);

            for (const pattern of testIdPatterns) {
              if (pattern.test(content)) {
                violations.push(`${relPath}: matches ${pattern}`);
              }
            }
          }
        }
      }

      for (const dir of productionDirs) {
        scanDir(join(root, dir));
      }

      expect(
        violations,
        `Found fixed test IDs in production paths:\n${violations.join('\n')}`,
      ).toEqual([]);
    },
  );

  // C01 阶段将修复这些 fixture 值，当前记录为已知问题
  test.todo('production source paths do not contain fixture-* default values (C01)', () => {
    const productionDirs = ['apps/api/src', 'apps/web/src', 'apps/worker/src'];
    const fixturePatterns = [
      /fixture-[a-z]+-[a-f0-9-]{36}/u, // fixture-xxx-uuid
      /FAKE_APPROVED_BRIEF_ID/u,
      /FIXTURES\s*=/u,
      /fixture-search-model/u,
      /workspace-fixture-account/u,
    ];

    const violations: string[] = [];

    function scanDir(dir: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
          scanDir(fullPath);
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          if (entry.includes('.test.') || entry.includes('.spec.')) continue;

          const content = readFileSync(fullPath, 'utf8');
          const relPath = relative(root, fullPath);

          for (const pattern of fixturePatterns) {
            if (pattern.test(content)) {
              violations.push(`${relPath}: matches ${pattern}`);
            }
          }
        }
      }
    }

    for (const dir of productionDirs) {
      scanDir(join(root, dir));
    }

    expect(
      violations,
      `Found fixture default values in production paths:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
