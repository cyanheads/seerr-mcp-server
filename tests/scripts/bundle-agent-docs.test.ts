/**
 * @fileoverview Tests for the agent-doc matcher shared by `scripts/clean-mcpb.ts`
 * (the bundle strip step) and `scripts/lint-packaging.ts` (check 8). Headline:
 * agent docs are removed only at a package root, so the MCP SDK's nested
 * `dist/ext/skills/` runtime modules survive bundling and the `.mcpb` boots.
 * Covers: scoped, unscoped, and nested-`node_modules` package roots; runtime
 * `skills/` directories below a package root; a package whose own name is
 * `skills`; and the two matchers agreeing entry for entry.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * `lint-packaging.ts` keeps a repository-only fallback import that a consumer's
 * `tsc` cannot resolve, so the module is loaded by URL at runtime and typed by
 * the two exports used here (cyanheads/mcp-ts-core#797).
 */
interface LintPackagingAgentDocs {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

const lintPackaging = (await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
)) as LintPackagingAgentDocs;

/** Runtime files a bundle must keep: code that merely lives under a nested `skills/` directory. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
  'node_modules/some-lib/node_modules/@modelcontextprotocol/core/dist/ext/skills/loader.mjs',
  'node_modules/some-lib/dist/skills/registry.js',
  'node_modules/some-lib/lib/.claude/runtime-config.js',
  'node_modules/@acme/skills/index.js',
  'node_modules/skills/package.json',
];

/** Agent docs a dependency ships at its own package root, which a bundle must not carry. */
const PACKAGE_ROOT_AGENT_DOCS = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-linter/references/rules.md',
  'node_modules/some-pkg/skills/do-thing/SKILL.md',
  'node_modules/@scope/pkg/skills/do-thing/references/notes.md',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/x/SKILL.md',
  'node_modules/some-pkg/SKILL.md',
  'node_modules/outer/node_modules/@scope/inner/skills/x/SKILL.md',
  'node_modules/outer/node_modules/inner/framework-skills/setup/SKILL.md',
];

describe('bundle agent-doc matcher', () => {
  describe('scripts/clean-mcpb.ts', () => {
    it('keeps scoped, unscoped, and nested runtime skills modules', () => {
      expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
    });

    it('removes agent docs at every package root, nested packages included', () => {
      expect(filterAgentDocEntries(PACKAGE_ROOT_AGENT_DOCS)).toEqual(PACKAGE_ROOT_AGENT_DOCS);
    });

    it('never reaches outside node_modules', () => {
      expect(
        filterAgentDocEntries([
          'skills/seerr-requests/SKILL.md',
          'framework-skills/add-tool/SKILL.md',
        ]),
      ).toEqual([]);
    });
  });

  describe('scripts/lint-packaging.ts check 8', () => {
    it('passes a bundle whose only skills entries are SDK runtime modules', () => {
      expect(lintPackaging.checkBundleEntries(RUNTIME_ENTRIES, 'dist/test.mcpb')).toEqual([]);
    });

    it('fails a bundle that still holds package-root agent docs', () => {
      const errors = lintPackaging.checkBundleEntries(
        [...RUNTIME_ENTRIES, ...PACKAGE_ROOT_AGENT_DOCS],
        'dist/test.mcpb',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        `contains ${PACKAGE_ROOT_AGENT_DOCS.length} node_modules agent-doc entries`,
      );
    });
  });

  it('keeps the two matchers in sync', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });
});
