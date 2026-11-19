/**
 * @fileoverview Tests for the ATX-heading escaper. Headline: an upstream value
 * holding a line break renders as one heading that parses back to the value,
 * and the block after it stays its own paragraph. Covers LF, CRLF, lone CR,
 * setext underline lines, an ATX line after a break, edge breaks, a literal
 * backslash before a break, and that
 * single-line values render exactly as `escapeMarkdownInline` renders them.
 * @module tests/tools/escape-markdown-heading.test
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { escapeMarkdownHeading } from '@/mcp-server/tools/escape-markdown-heading.js';
import { readBlocks } from '../helpers/commonmark.js';

/** A heading slot shaped like the tools' own: authored text after the value, a facts line below. */
function render(value: string): string {
  return `## ${escapeMarkdownHeading(value)} — movie\n**TMDB ID:** 1`;
}

const HEADING_THEN_FACTS = (text: string) => [
  'heading_open',
  `inline:${text}`,
  'heading_close',
  'paragraph_open',
  'inline:⟨strong⟩TMDB ID:⟨/strong⟩ 1',
  'paragraph_close',
];

describe('escapeMarkdownHeading', () => {
  it.each([
    ['LF', 'a\nb', 'a\nb'],
    ['CRLF, read back as LF', 'a\r\nb', 'a\nb'],
    ['lone CR, read back as LF', 'a\rb', 'a\nb'],
    ['a setext --- line', 'top\n---\nbottom', 'top\n---\nbottom'],
    ['a setext === line', 'top\n===\nbottom', 'top\n===\nbottom'],
    ['an ATX line after a break', 'a\n# b', 'a\n# b'],
    ['a leading line break', '\na', '\na'],
    ['a trailing line break', 'a\n', 'a\n'],
    ['a blank line', 'a\n\nb', 'a\n\nb'],
    ['a list line after a break', 'a\n- b', 'a\n- b'],
    ['a backslash before a line break', 'a\\\nb', 'a\\\nb'],
  ])('keeps a value with %s in one heading', (_label, value, readBack) => {
    expect(readBlocks(render(value))).toEqual(HEADING_THEN_FACTS(`${readBack} — movie`));
  });

  it.each([
    'Mulan',
    'Cafe ###',
    '#',
    '  edge spaces  ',
    '*not* _em_ [x](y) `c` <b>',
    'a\u{2028}b\u{2029}c',
    'trailing backslash\\',
    '&#10; &amp;',
    '',
  ])('renders single-line value %j exactly as escapeMarkdownInline does', (value) => {
    expect(escapeMarkdownHeading(value)).toBe(escapeMarkdownInline(value));
  });

  it('reads a single-line hostile value back as written', () => {
    const value = 'Cafe ### *not* [x](y) <b>';
    expect(readBlocks(render(value))).toEqual(HEADING_THEN_FACTS(`${value} — movie`));
  });
});
