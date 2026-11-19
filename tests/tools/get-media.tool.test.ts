/**
 * @fileoverview Tests for seerr_get_media. Headline: fetch exact movie/TV detail by
 * TMDB ID to confirm the title before a write. Covers: movie detail with
 * runtime/status, TV per-season summary, the seasonNumber episode-list branch, the
 * openRequest derived from mediaInfo.requests (PII-redacted) for movies and shows,
 * the media_not_found contract bubbling from the service, Seerr's not-found 500s
 * classified by the real service (an unknown show, a season the show lacks), and
 * season/episode rendering in format().
 * @module tests/tools/get-media.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeerrService } from '@/services/seerr/seerr-service.js';
import { readBlocks, readHeadings } from '../helpers/commonmark.js';

const service = { getMovie: vi.fn(), getTv: vi.fn(), getSeason: vi.fn() };

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    baseUrl: 'http://seerr.test:5055',
    apiKey: 'TEST-API-KEY',
    requestTimeoutMs: 15000,
  }),
}));

/**
 * The stub serves every suite but one: the upstream-status suite sets `live` to a
 * real SeerrService over a mocked `fetch`, so Seerr's status reaches the tool
 * through the service's own classification.
 */
let live: SeerrService | undefined;

vi.mock('@/services/seerr/seerr-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/seerr/seerr-service.js')>()),
  getSeerrService: () => live ?? service,
}));

const seerrModule = await import('@/services/seerr/seerr-service.js');
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

  /**
   * `openRequest` is the newest request at any quality and in any state — a
   * completed 4K request newer than an approved non-4K one is what it reports.
   */
  it('reports the latest request whatever its quality or state, labelled as the latest', async () => {
    service.getMovie.mockResolvedValue({
      id: 1275779,
      title: 'Disclosure Day',
      mediaInfo: {
        status: 5,
        requests: [
          { id: 45, status: 2, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 46, status: 5, is4k: true, createdAt: '2026-03-01T00:00:00.000Z' },
        ],
      },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getMediaTool.errors });
    const result = await getMediaTool.handler(
      getMediaTool.input.parse({ mediaType: 'movie', tmdbId: 1275779 }),
      ctx,
    );

    expect(result.availability.openRequest).toEqual({
      requestId: 46,
      status: { raw: 5, label: 'completed' },
      is4k: true,
    });
    const text = (getMediaTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain(
      '\n**Latest request:** #46 — status completed (5) | 4K=true — track with seerr_request_status.',
    );
    expect(text).not.toContain('Open request');
  });

  it('describes openRequest as the latest request, never an open one', () => {
    expect(getMediaTool.description).not.toMatch(/open request/i);
    const openRequest = getMediaTool.output.shape.availability.shape.openRequest;
    expect(openRequest.description).toMatch(/^Latest request for this title/);
    expect(openRequest.unwrap().shape.is4k.description).toBe(
      'Whether the latest request is for 4K.',
    );
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

  it('derives openRequest for a show from mediaInfo.requests with the requester PII stripped', async () => {
    service.getTv.mockResolvedValue({
      id: 1399,
      name: 'Game of Thrones',
      seasons: [],
      mediaInfo: {
        status: 4,
        requests: [
          {
            id: 77,
            status: 1,
            is4k: false,
            createdAt: '2026-02-01T00:00:00.000Z',
            seasons: [{ seasonNumber: 2 }],
            requestedBy: { id: 3, username: 'viewer', email: 'leak@example.com' },
          },
        ],
      },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getMediaTool.errors });
    const result = await getMediaTool.handler(
      getMediaTool.input.parse({ mediaType: 'tv', tmdbId: 1399 }),
      ctx,
    );

    expect(result.availability).toEqual({
      tracked: true,
      status: { raw: 4, label: 'partially_available' },
      openRequest: { requestId: 77, status: { raw: 1, label: 'pending' }, is4k: false },
    });
    expect(JSON.stringify(result)).not.toContain('leak@example.com');
  });
});

/**
 * Seerr answers both a TMDB id it can't resolve and a season the show doesn't have
 * with HTTP 500, which the generic status mapping reads as a retryable outage. These
 * run the real SeerrService over a mocked `fetch`, so the endpoint tag the service
 * passes and the classifier it feeds are both in the path.
 */
describe('seerr_get_media — Seerr not-found answers through the service', () => {
  const show = {
    id: 1399,
    name: 'Game of Thrones',
    seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 10, airDate: '2011-04-17' }],
  };

  /** Install a `fetch` that serves each Seerr path from `routes` and refuses any other. */
  function serve(routes: Map<string, () => Response>) {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const respond = url.origin === 'http://seerr.test:5055' && routes.get(url.pathname);
      if (!respond) throw new Error(`Unrouted Seerr call: ${url.pathname}`);
      return respond();
    });
    vi.stubGlobal('fetch', fetchMock);
    live = new seerrModule.SeerrService();
    return fetchMock;
  }

  const pathsOf = (fetchMock: ReturnType<typeof serve>) =>
    fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);

  afterEach(() => {
    vi.unstubAllGlobals();
    live = undefined;
  });

  it('reports a season the show lacks as season_not_found on both result surfaces', async () => {
    const fetchMock = serve(
      new Map([
        ['/api/v1/tv/1399', () => Response.json(show)],
        [
          '/api/v1/tv/1399/season/99',
          () => Response.json({ message: 'Unable to retrieve season.' }, { status: 500 }),
        ],
      ]),
    );

    const result = await runToolContract(getMediaTool, {
      mediaType: 'tv',
      tmdbId: 1399,
      seasonNumber: 99,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'Unable to retrieve the requested season from Seerr.',
        data: {
          reason: 'season_not_found',
          httpStatus: 500,
          retryable: false,
          recovery: {
            hint: "Call seerr_get_media without seasonNumber to list the show's seasons, then retry with one of the listed season numbers.",
          },
        },
      },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(readBlocks(text).filter((block) => block.startsWith('inline:'))).toEqual([
      'inline:Error: Unable to retrieve the requested season from Seerr.',
      "inline:Recovery: Call seerr_get_media without seasonNumber to list the show's seasons, then retry with one of the listed season numbers.",
      'inline:(reason season_not_found · not retryable)',
    ]);
    // A classified not-found is final: the season is read once, never retried.
    expect(pathsOf(fetchMock)).toEqual(['/api/v1/tv/1399', '/api/v1/tv/1399/season/99']);
  });

  it('reads the show before any season, so an unknown show reports media_not_found', async () => {
    const fetchMock = serve(
      new Map([
        [
          '/api/v1/tv/404404',
          () => Response.json({ message: 'Unable to retrieve series.' }, { status: 500 }),
        ],
      ]),
    );

    const result = await runToolContract(getMediaTool, {
      mediaType: 'tv',
      tmdbId: 404404,
      seasonNumber: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'media_not_found' } },
    });
    expect(pathsOf(fetchMock)).toEqual(['/api/v1/tv/404404']);
  });
});

describe('seerr_get_media — format', () => {
  it('keeps a title holding a line break in one heading', () => {
    const blocks = getMediaTool.format!({
      tmdbId: 603,
      mediaType: 'movie',
      title: 'Line\nBreak',
      year: 1999,
      availability: { tracked: false, status: { raw: 1, label: 'unknown' } },
    });
    expect(readHeadings((blocks[0] as { text: string }).text)).toEqual([
      'Line\nBreak (1999) — movie',
    ]);
  });

  it('renders season and episode lines with upstream names escaped', () => {
    const blocks = getMediaTool.format!({
      tmdbId: 1399,
      mediaType: 'tv',
      title: 'Game of Thrones',
      availability: { tracked: false, status: { raw: 1, label: 'unknown' } },
      seasons: [{ seasonNumber: 1, name: 'Season *1*', episodeCount: 10, airDate: '2011-04-17' }],
      episodes: [
        { episodeNumber: 1, name: '[Pilot]', airDate: '2011-04-17', overview: 'Winter_is_coming.' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('- **S1 Season \\*1\\*** — 10 episodes (aired 2011-04-17)');
    expect(text).toContain('- **E1 \\[Pilot\\]** (2011-04-17)');
    expect(text).toContain('  Winter_is_coming.');
  });

  it('escapes upstream air dates', () => {
    const blocks = getMediaTool.format!({
      tmdbId: 1399,
      mediaType: 'tv',
      title: 'Game of Thrones',
      availability: { tracked: false, status: { raw: 1, label: 'unknown' } },
      seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 10, airDate: '2011 *x*' }],
      episodes: [{ episodeNumber: 1, name: 'Pilot', airDate: '<b>2011</b>' }],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(aired 2011 \\*x\\*)');
    expect(text).toContain('- **E1 Pilot** (\\<b>2011\\</b>)');
  });
});
