/**
 * @fileoverview Tests for seerr_search_media. Headline: a title query returns
 * ranked movie/TV matches with TMDB IDs and decoded availability when tracked.
 * Covers: person results excluded, movie/TV title+year normalization, the sparse
 * (untracked → no mediaInfo) path, totalCount as Seerr's own every-type total on
 * both surfaces, the empty-result notice and its mediaType hint, and format
 * rendering, with content[] read back through a CommonMark parse.
 * @module tests/tools/search-media.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readBlocks, readHeadings } from '../helpers/commonmark.js';

const service = { search: vi.fn() };

vi.mock('@/services/seerr/seerr-service.js', () => ({ getSeerrService: () => service }));

const { searchMediaTool } = await import('@/mcp-server/tools/definitions/search-media.tool.js');

const TOTAL_QUALIFIER = "(Seerr's count across movies, TV shows, and people)";

/** The `content[]` trailer the framework appends after `format()`'s one block. */
function trailerOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  expect(result.content).toHaveLength(2);
  return (result.content[1] as { text: string }).text;
}

describe('seerr_search_media', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ranked movie/TV matches with tmdbId, normalized title/year, and excludes people', async () => {
    service.search.mockResolvedValue({
      page: 1,
      // Seerr's total counts the person too.
      totalResults: 3,
      results: [
        {
          id: 10674,
          mediaType: 'movie',
          title: 'Mulan',
          releaseDate: '1998-06-18',
          overview: 'A girl.',
          voteAverage: 7.7,
        },
        { id: 1668, mediaType: 'tv', name: 'Friends', firstAirDate: '1994-09-22' },
        { id: 555, mediaType: 'person', name: 'Some Actor' },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await searchMediaTool.handler(
      searchMediaTool.input.parse({ query: 'Mulan' }),
      ctx,
    );

    expect(result.results).toHaveLength(2); // person dropped
    expect(result.results[0]).toMatchObject({
      tmdbId: 10674,
      mediaType: 'movie',
      title: 'Mulan',
      year: 1998,
    });
    expect(result.results[1]).toMatchObject({
      tmdbId: 1668,
      mediaType: 'tv',
      title: 'Friends',
      year: 1994,
    });
    expect(getEnrichment(ctx).totalCount).toBe(3);
  });

  it('marks an untracked title (no mediaInfo) as tracked:false with no availability (sparse path)', async () => {
    service.search.mockResolvedValue({
      totalResults: 1,
      results: [{ id: 10674, mediaType: 'movie', title: 'Mulan', releaseDate: '1998-06-18' }],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await searchMediaTool.handler(
      searchMediaTool.input.parse({ query: 'Mulan' }),
      ctx,
    );
    expect(result.results[0]!.tracked).toBe(false);
    expect(result.results[0]!.availability).toBeUndefined();
  });

  it('decodes availability for a tracked title from mediaInfo.status/status4k only', async () => {
    service.search.mockResolvedValue({
      totalResults: 1,
      results: [
        {
          id: 1275779,
          mediaType: 'movie',
          title: 'Disclosure Day',
          releaseDate: '2026-06-10',
          // mediaInfo also carries serviceUrl etc. — must NOT surface.
          mediaInfo: { status: 5, status4k: 3, serviceUrl: 'http://203.0.113.10:3106/x' },
        },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await searchMediaTool.handler(
      searchMediaTool.input.parse({ query: 'Disclosure' }),
      ctx,
    );
    expect(result.results[0]!.tracked).toBe(true);
    expect(result.results[0]!.availability).toEqual({
      status: { raw: 5, label: 'available' },
      status4k: { raw: 3, label: 'processing' },
    });
    expect(JSON.stringify(result)).not.toContain('203.0.113.10');
  });

  describe('totalCount', () => {
    /** One person and three titles; Seerr's total counts all four. */
    const MIXED_PAGE = {
      page: 1,
      totalResults: 4,
      results: [
        { id: 1, mediaType: 'movie', title: 'Alpha' },
        { id: 2, mediaType: 'person', name: 'Some Actor' },
        { id: 3, mediaType: 'tv', name: 'Beta' },
        { id: 4, mediaType: 'movie', title: 'Gamma' },
      ],
    };

    it('describes totalCount as every result type, people included, mediaType not applied', () => {
      const description = searchMediaTool.enrichment?.totalCount.description ?? '';
      expect(description).toContain('movies, TV shows, and people');
      expect(description).toContain('mediaType not applied');
    });

    it.each([
      ['all', 3],
      ['movie', 2],
    ] as const)(
      "keeps Seerr's total under mediaType %s and qualifies it in content[]",
      async (mediaType, returned) => {
        service.search.mockResolvedValue(MIXED_PAGE);
        const result = await runToolContract(searchMediaTool, { query: 'mixed', mediaType });

        const structured = result.structuredContent as { results: unknown[]; totalCount: number };
        expect(structured.results).toHaveLength(returned);
        expect(structured.totalCount).toBe(4);
        expect(readBlocks(trailerOf(result))).toEqual([
          'paragraph_open',
          `inline:Query: ⟨code_inline:mixed⟩\n⟨strong⟩4 total⟨/strong⟩ ${TOTAL_QUALIFIER}`,
          'paragraph_close',
        ]);
      },
    );

    it('fails loudly rather than reporting a page count when Seerr sends no totalResults', async () => {
      service.search.mockResolvedValue({
        results: [{ id: 1, mediaType: 'movie', title: 'Alpha' }],
      });
      const result = await runToolContract(searchMediaTool, { query: 'Alpha' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InternalError },
      });
      expect(JSON.stringify(result)).not.toContain('1 total');
    });
  });

  describe('no-match notice', () => {
    const PEOPLE_ONLY = { totalResults: 1, results: [{ id: 1, mediaType: 'person', name: 'X' }] };

    it.each([
      ['movie', 'No movie/TV match. Try a different spelling or broaden mediaType to "all".'],
      ['tv', 'No movie/TV match. Try a different spelling or broaden mediaType to "all".'],
      ['all', 'No movie/TV match. Try a different spelling.'],
    ] as const)(
      'offers the mediaType hint only when it would widen the search (%s)',
      async (mediaType, notice) => {
        service.search.mockResolvedValue(PEOPLE_ONLY);
        const ctx = createMockContext({ tenantId: 'test' });
        const result = await searchMediaTool.handler(
          searchMediaTool.input.parse({ query: 'X', mediaType }),
          ctx,
        );
        expect(result.results).toHaveLength(0);
        expect(getEnrichment(ctx).notice).toBe(notice);
      },
    );

    it('keeps Markdown in the query out of the notice; the Query: line carries it as code', async () => {
      const query = '*zzqq* [x](https://example.com)';
      service.search.mockResolvedValue(PEOPLE_ONLY);
      const result = await runToolContract(searchMediaTool, { query });

      expect(result.structuredContent).toMatchObject({
        effectiveQuery: query,
        notice: 'No movie/TV match. Try a different spelling.',
      });
      expect(readBlocks(trailerOf(result))).toEqual([
        'paragraph_open',
        `inline:Query: ⟨code_inline:${query}⟩\n⟨strong⟩1 total⟨/strong⟩ ${TOTAL_QUALIFIER}`,
        'paragraph_close',
        'blockquote_open',
        'paragraph_open',
        'inline:No movie/TV match. Try a different spelling.',
        'paragraph_close',
        'blockquote_close',
      ]);
    });

    /** The lone hit is the boundary the notice must stay quiet on: one result is a match. */
    it('carries no notice for exactly one movie/TV hit, on both surfaces', async () => {
      service.search.mockResolvedValue({
        totalResults: 2,
        results: [
          { id: 10674, mediaType: 'movie', title: 'Mulan', releaseDate: '1998-06-18' },
          { id: 555, mediaType: 'person', name: 'Some Actor' },
        ],
      });
      const result = await runToolContract(searchMediaTool, { query: 'Mulan' });

      const structured = result.structuredContent as { results: unknown[] };
      expect(structured.results).toHaveLength(1);
      expect(structured).not.toHaveProperty('notice');
      expect(readBlocks(trailerOf(result))).toEqual([
        'paragraph_open',
        `inline:Query: ⟨code_inline:Mulan⟩\n⟨strong⟩2 total⟨/strong⟩ ${TOTAL_QUALIFIER}`,
        'paragraph_close',
      ]);
    });

    it('keeps a line-broken query from opening blocks inside the notice', async () => {
      const query = 'zz\n# heading\n- item';
      service.search.mockResolvedValue(PEOPLE_ONLY);
      const result = await runToolContract(searchMediaTool, { query });

      expect(result.structuredContent).toMatchObject({
        effectiveQuery: query,
        notice: 'No movie/TV match. Try a different spelling.',
      });
      const trailer = trailerOf(result);
      expect(readBlocks(trailer)).toEqual([
        'paragraph_open',
        'inline:Query:',
        'paragraph_close',
        'fence',
        'paragraph_open',
        `inline:⟨strong⟩1 total⟨/strong⟩ ${TOTAL_QUALIFIER}`,
        'paragraph_close',
        'blockquote_open',
        'paragraph_open',
        'inline:No movie/TV match. Try a different spelling.',
        'paragraph_close',
        'blockquote_close',
      ]);
      // readBlocks names a fence without its body; CommonMark ends a fence's content with a line break.
      const fence = new MarkdownIt('commonmark').parse(trailer, {}).find((t) => t.type === 'fence');
      expect(fence?.content).toBe(`${query}\n`);
    });
  });

  it('formats results with TMDB ID and availability', () => {
    const blocks = searchMediaTool.format!({
      results: [
        {
          tmdbId: 1275779,
          mediaType: 'movie',
          title: 'Disclosure Day',
          year: 2026,
          tracked: true,
          availability: { status: { raw: 5, label: 'available' } },
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1275779');
    expect(text).toContain('available (5)');
  });

  it('escapes Markdown syntax in upstream title and overview so content[] reads back as written', () => {
    const blocks = searchMediaTool.format!({
      results: [
        {
          tmdbId: 1,
          mediaType: 'tv',
          title: '*NSYNC: [Live]',
          overview: 'The _final_ tour.',
          tracked: false,
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('## \\*NSYNC: \\[Live\\] — tv');
    expect(text).toContain('The \\_final\\_ tour.');
  });

  it('keeps a title holding a line break in its one heading', () => {
    const blocks = searchMediaTool.format!({
      results: [
        { tmdbId: 1, mediaType: 'movie', title: 'Line\nBreak', year: 2020, tracked: false },
      ],
    });
    expect(readHeadings((blocks[0] as { text: string }).text)).toEqual([
      'Line\nBreak (2020) — movie',
    ]);
  });
});
