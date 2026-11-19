/**
 * @fileoverview Reads `content[]` Markdown back through a real CommonMark
 * parser (`markdown-it`, commonmark preset), so a test asserts what a client
 * renders rather than which bytes were written.
 * @module tests/helpers/commonmark
 */

import MarkdownIt, { type Token } from 'markdown-it';

const parser = new MarkdownIt('commonmark');

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/**
 * The block tokens of `markdown` in document order, each inline run read as
 * its text with any live syntax named in place (`⟨strong⟩…⟨/strong⟩`), so a
 * plain-text expectation fails on formatting the value was not meant to carry.
 * An inline run appears as `inline:<text>`; every other block as its type.
 */
export function readBlocks(markdown: string): string[] {
  return parser
    .parse(markdown, {})
    .map((token) =>
      token.type === 'inline' ? `inline:${readInline(token.children ?? [])}` : token.type,
    );
}

/** The text of every heading in `markdown`, in document order. */
export function readHeadings(markdown: string): string[] {
  const tokens = parser.parse(markdown, {});
  const headings: string[] = [];
  tokens.forEach((token, i) => {
    const inline = tokens[i + 1];
    if (token.type === 'heading_open' && inline?.type === 'inline') {
      headings.push(readInline(inline.children ?? []));
    }
  });
  return headings;
}
