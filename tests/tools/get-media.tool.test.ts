/**
 * @fileoverview Tests for seerr_get_media. Headline: fetch exact movie/TV detail by
 * TMDB ID to confirm the title before a write. Covers: movie detail with
 * runtime/status, TV per-season summary, the seasonNumber episode-list branch, the
 * openRequest derived from mediaInfo.requests (PII-redacted), and the media_not_found
 * contract bubbling from the service.
 * @module tests/tools/get-media.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = { getMovie: vi.fn(), getTv: vi.fn(), getSeason: vi.fn() };

vi.mock('@/services/seerr/seerr-service.js', () => ({ getSeerrService: () => service }));

const { getMediaTool } = await import('@/mcp-server/tools/definitions/get-media.tool.js');

describe('seerr_get_media — movie', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns movie detail with runtime, production status, and availability', async () => {
    service.getMovie.mockResolvedValue({
      id: 1275779,
      title: 'Disclosure Day',
      releaseDate: '2026-06-10',
      runtime: 145,
      status: 'Released',
      overview: 'A film.',
      mediaInfo: { status: 5, status4k: 1 },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getMediaTool.errors });
    const result = await getMediaTool.handler(
      getMediaTool.input.parse({ mediaType: 'movie', tmdbId: 1275779 }),
      ctx,
    );
    expect(result).toMatchObject({
      tmdbId: 1275779,
      mediaType: 'movie',
      title: 'Disclosure Day',
      year: 2026,
      runtimeMinutes: 145,
      productionStatus: 'Released',
    });
    expect(result.availability).toMatchObject({
      tracked: true,
      status: { raw: 5, label: 'available' },
    });
  });

  it('derives openRequest from mediaInfo.requests with the requester PII stripped', async () => {
    service.getMovie.mockResolvedValue({
      id: 1275779,
      title: 'Disclosure Day',
      mediaInfo: {
        status: 3,
        requests: [
          {
            id: 45,
            status: 2,
            is4k: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            requestedBy: {
              id: 1,
              username: 'mediauser',
              email: 'leak@example.com',
              plexToken: 'SECRET',
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getMediaTool.errors });
    const result = await getMediaTool.handler(
      getMediaTool.input.parse({ mediaType: 'movie', tmdbId: 1275779 }),
      ctx,
    );
    expect(result.availability.openRequest).toEqual({
      requestId: 45,
      status: { raw: 2, label: 'approved' },
      is4k: false,
    });
    expect(JSON.stringify(result)).not.toContain('leak@example.com');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('bubbles media_not_found from the service for an unknown TMDB id', async () => {
    service.getMovie.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'Unable to retrieve the requested title from Seerr.',
        {
          reason: 'media_not_found',
        },
      ),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: getMediaTool.errors });
    await expect(
      getMediaTool.handler(
        getMediaTool.input.parse({ mediaType: 'movie', tmdbId: 99999999999 }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'media_not_found' },
    });
  });
});

describe('seerr_get_media — TV', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a per-season summary when seasonNumber is omitted', async () => {
    service.getTv.mockResolvedValue({
      id: 1399,
      name: 'Game of Thrones',
      firstAirDate: '2011-04-17',
      numberOfSeasons: 8,
      seasons: [
        { seasonNumber: 0, name: 'Specials', episodeCount: 14, airDate: null },
        { seasonNumber: 1, name: 'Season 1', episodeCount: 10, airDate: '2011-04-17' },
      ],
      mediaInfo: undefined,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getMediaTool.errors });
    const result = await getMediaTool.handler(
      getMediaTool.input.parse({ mediaType: 'tv', tmdbId: 1399 }),
      ctx,
    );
    expect(result.mediaType).toBe('tv');
    expect(result.seasons).toHaveLength(2);
    expect(result.seasons?.[0]).toMatchObject({
      seasonNumber: 0,
      name: 'Specials',
      episodeCount: 14,
      airDate: null,
    });
    expect(result.episodes).toBeUndefined();
    expect(service.getSeason).not.toHaveBeenCalled();
  });

  it('fetches the episode list when seasonNumber is provided', async () => {
    service.getTv.mockResolvedValue({
      id: 1399,
      name: 'Game of Thrones',
      seasons: [],
      mediaInfo: undefined,
    });
    service.getSeason.mockResolvedValue({
      seasonNumber: 1,
      episodes: [
        { episodeNumber: 1, name: 'Winter Is Coming', airDate: '2011-04-17', overview: 'Pilot.' },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getMediaTool.errors });
    const result = await getMediaTool.handler(
      getMediaTool.input.parse({ mediaType: 'tv', tmdbId: 1399, seasonNumber: 1 }),
      ctx,
    );
    expect(service.getSeason).toHaveBeenCalledWith(1399, 1, ctx);
    expect(result.episodes).toEqual([
      { episodeNumber: 1, name: 'Winter Is Coming', airDate: '2011-04-17', overview: 'Pilot.' },
    ]);
  });
});
