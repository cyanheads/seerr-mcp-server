/**
 * @fileoverview Tests for seerr_search_media. Headline: a title query returns
 * ranked movie/TV matches with TMDB IDs and decoded availability when tracked.
 * Covers: person results excluded, movie/TV title+year normalization, the sparse
 * (untracked → no mediaInfo) path, the empty-result notice, and format rendering.
 * @module tests/tools/search-media.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = { search: vi.fn() };

vi.mock('@/services/seerr/seerr-service.js', () => ({ getSeerrService: () => service }));

const { searchMediaTool } = await import('@/mcp-server/tools/definitions/search-media.tool.js');

describe('seerr_search_media', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ranked movie/TV matches with tmdbId, normalized title/year, and excludes people', async () => {
    service.search.mockResolvedValue({
      page: 1,
      totalResults: 2,
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
    expect(getEnrichment(ctx).totalCount).toBe(2);
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

  it('emits a notice when nothing matches the filter', async () => {
    service.search.mockResolvedValue({
      totalResults: 5,
      results: [{ id: 1, mediaType: 'person', name: 'X' }],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await searchMediaTool.handler(
      searchMediaTool.input.parse({ query: 'X', mediaType: 'movie' }),
      ctx,
    );
    expect(result.results).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('No movie/TV match');
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
});
