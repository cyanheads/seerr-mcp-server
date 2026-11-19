/**
 * @fileoverview Escapes an upstream value for an ATX heading in `content[]`.
 * `escapeMarkdownInline` writes a line break as a backslash hard break, which
 * holds in a paragraph but ends a heading: the rest of the value would spill
 * into the next block. Each hard break becomes a `&#10;` character reference
 * instead, so the heading stays one line and parses back to the value, with CR
 * and CRLF read back as LF, the same contract as every other inline slot.
 * @module mcp-server/tools/escape-markdown-heading
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * `escapeMarkdownInline` for text inside an ATX heading. Output for a value
 * without a line break is identical to `escapeMarkdownInline`.
 */
export function escapeMarkdownHeading(text: string): string {
  // escapeMarkdownInline doubles a literal trailing backslash, so `\` + LF in its output is always a hard break.
  return escapeMarkdownInline(text).replace(/\\\n/g, '&#10;');
}
