/**
 * @fileoverview Tests for seerr_list_requests. Headline: list recent requests with
 * decoded statuses and a PII-redacted requester. Covers: type→mediaType mapping,
 * media.tmdbId/status projection, requester redaction, totalCount from
 * pageInfo.results, the empty-result notice, format rendering, and the opt-in
 * includeTitles hydration path (default cost, dedupe, and both degrade modes).
 * @module tests/tools/list-requests.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeerrService } from '@/services/seerr/seerr-service.js';
import { readHeadings } from '../helpers/commonmark.js';

const service = { listRequests: vi.fn(), getMovie: vi.fn(), getTv: vi.fn() };

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    baseUrl: 'http://seerr.test:5055',
    apiKey: 'TEST-API-KEY',
    requestTimeoutMs: 15000,
  }),
}));

/**
 * The stub serves every suite but one: the upstream-status case sets `live` to a
 * real SeerrService over a mocked `fetch`, so Seerr's status reaches the tool
 * through the service's own classification.
 */
let live: SeerrService | undefined;

vi.mock('@/services/seerr/seerr-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/seerr/seerr-service.js')>()),
  getSeerrService: () => live ?? service,
}));

const seerrModule = await import('@/services/seerr/seerr-service.js');
const { listRequestsTool } = await import('@/mcp-server/tools/definitions/list-requests.tool.js');

/**
 * The first retry keeps `filter`, since an instance that rejects `mediaType` can
 * still accept the filter value. Seerr selects "failed" and "completed" on the
 * request status but "deleted" on the media status, so each fallback names the
 * field that carries its value.
 */
const UNSUPPORTED_FILTER_RECOVERY =
  'Retry with mediaType "all" and the default sortDirection, keeping filter. If that is rejected too and filter was "failed", "completed", or "deleted", retry with filter "all" and pick the rows yourself: "failed" and "completed" by each row\'s requestStatus, "deleted" by its mediaStatus (mediaStatus4k on an is4k row).';

/** Every `content[]` text block of a contract result, joined in order. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content as Array<{ text: string }>).map((block) => block.text).join('\n');
}

describe('seerr_list_requests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('decodes statuses, maps type→mediaType, and redacts the requester', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { page: 1, pages: 14, pageSize: 20, results: 41 },
      results: [
        {
          id: 45,
          type: 'movie',
          status: 2,
          is4k: false,
          seasons: [],
          createdAt: '2026-06-08T10:50:48.000Z',
          requestedBy: {
            id: 1,
            username: 'mediauser',
            email: 'leak@example.com',
            jellyfinUserId: 'jf-secret',
          },
          media: { tmdbId: 1275779, status: 3, serviceUrl: 'http://203.0.113.10:3106/x' },
        },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(listRequestsTool.input.parse({}), ctx);

    expect(result.requests[0]).toMatchObject({
      requestId: 45,
      mediaType: 'movie',
      tmdbId: 1275779,
      requestStatus: { raw: 2, label: 'approved' },
      mediaStatus: { raw: 3, label: 'processing' },
      is4k: false,
      requestedBy: { id: 1, displayName: 'mediauser' },
    });
    expect(getEnrichment(ctx).totalCount).toBe(41);
    const json = JSON.stringify(result);
    expect(json).not.toContain('leak@example.com');
    expect(json).not.toContain('jf-secret');
    expect(json).not.toContain('203.0.113.10');
  });

  /**
   * The 4K copy downloads through a separate Radarr/Sonarr service, so a 4K row whose
   * non-4K `status` still reads `unknown` must surface the 4K progress alongside it.
   */
  it('surfaces status4k so a 4K row is not reported as merely unknown', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 1 },
      results: [
        {
          id: 47,
          type: 'movie',
          status: 2,
          is4k: true,
          createdAt: '2026-06-08T10:50:48.000Z',
          requestedBy: { id: 1, username: 'mediauser' },
          media: { tmdbId: 1275779, status: 1, status4k: 3 },
        },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(listRequestsTool.input.parse({}), ctx);

    expect(result.requests[0]).toMatchObject({
      is4k: true,
      mediaStatus: { raw: 1, label: 'unknown' },
      mediaStatus4k: { raw: 3, label: 'processing' },
    });
    const text = (listRequestsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Media 4K:** processing (3)');
  });

  it('emits a notice when no requests match', async () => {
    service.listRequests.mockResolvedValue({ pageInfo: { results: 0 }, results: [] });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(
      listRequestsTool.input.parse({ filter: 'failed' }),
      ctx,
    );
    expect(result.requests).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('No requests matched');
  });

  /* --- includeTitles hydration --- */

  /**
   * One row per (mediaType, tmdbId). `null` yields a `media` object carrying no
   * tmdbId; `undefined` yields a row with no `media` object at all — Seerr produces
   * both, and neither is hydratable.
   */
  const requestRow = (id: number, type: 'movie' | 'tv', tmdbId: number | null | undefined) => ({
    id,
    type,
    status: 2,
    is4k: false,
    createdAt: '2026-06-08T10:50:48.000Z',
    requestedBy: { id: 1, username: 'mediauser' },
    ...(tmdbId === undefined ? {} : { media: tmdbId === null ? {} : { tmdbId, status: 3 } }),
  });

  it('makes no extra upstream calls when includeTitles is omitted', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 2 },
      results: [requestRow(47, 'movie', 299534), requestRow(49, 'tv', 1399)],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(listRequestsTool.input.parse({}), ctx);

    expect(service.getMovie).not.toHaveBeenCalled();
    expect(service.getTv).not.toHaveBeenCalled();
    expect(result.requests.every((r) => r.title === undefined)).toBe(true);
    expect(getEnrichment(ctx).notice).toBeUndefined();
    const text = (listRequestsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Request #47 — Untitled');
  });

  it('populates titles from the media endpoints when includeTitles is true', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 2 },
      results: [requestRow(47, 'movie', 299534), requestRow(49, 'tv', 1399)],
    });
    service.getMovie.mockResolvedValue({ id: 299534, title: 'Avengers: Endgame' });
    service.getTv.mockResolvedValue({ id: 1399, name: 'Game of Thrones' });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(
      listRequestsTool.input.parse({ includeTitles: true }),
      ctx,
    );

    expect(result.requests.map((r) => r.title)).toEqual(['Avengers: Endgame', 'Game of Thrones']);
    expect(getEnrichment(ctx).notice).toBeUndefined();
    const text = (listRequestsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Request #47 — Avengers: Endgame');
    expect(text).toContain('Request #49 — Game of Thrones');
    expect(text).not.toContain('Untitled');
  });

  /** A 4K and a non-4K request for one film share a tmdbId — one fetch, two titles. */
  it('fetches once for two rows sharing a (mediaType, tmdbId)', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 2 },
      results: [requestRow(47, 'movie', 299534), requestRow(48, 'movie', 299534)],
    });
    service.getMovie.mockResolvedValue({ id: 299534, title: 'Avengers: Endgame' });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(
      listRequestsTool.input.parse({ includeTitles: true }),
      ctx,
    );

    expect(service.getMovie).toHaveBeenCalledTimes(1);
    expect(result.requests.map((r) => r.title)).toEqual(['Avengers: Endgame', 'Avengers: Endgame']);
  });

  it('degrades quietly for a row with no tmdbId — not reported as a failure', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 2 },
      results: [requestRow(47, 'movie', 299534), requestRow(52, 'movie', null)],
    });
    service.getMovie.mockResolvedValue({ id: 299534, title: 'Avengers: Endgame' });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(
      listRequestsTool.input.parse({ includeTitles: true }),
      ctx,
    );

    expect(service.getMovie).toHaveBeenCalledTimes(1);
    expect(result.requests[1]).toMatchObject({
      requestId: 52,
      requestStatus: { label: 'approved' },
    });
    expect(result.requests[1]?.title).toBeUndefined();
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toBe('Titles unavailable for 1 request with no tmdbId.');
    expect(notice).not.toContain('failed');
  });

  it('discloses a failed lookup in the notice while keeping the row intact', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 2 },
      results: [requestRow(47, 'movie', 299534), requestRow(53, 'movie', 404404)],
    });
    service.getMovie.mockImplementation(async (tmdbId: number) => {
      if (tmdbId === 404404) throw new Error('Unable to retrieve movie.');
      return { id: tmdbId, title: 'Avengers: Endgame' };
    });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(
      listRequestsTool.input.parse({ includeTitles: true }),
      ctx,
    );

    expect(result.requests[0]?.title).toBe('Avengers: Endgame');
    expect(result.requests[1]).toMatchObject({ requestId: 53, tmdbId: 404404 });
    expect(result.requests[1]?.title).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBe(
      'Title lookup failed for 1 request; those rows keep every other field.',
    );
    const text = (listRequestsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Request #53 — Untitled');
  });

  /** A row with no `media` object at all is the same non-failure as one with an empty `media`. */
  it('degrades quietly for a row carrying no media object', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 2 },
      results: [requestRow(47, 'movie', 299534), requestRow(55, 'movie', undefined)],
    });
    service.getMovie.mockResolvedValue({ id: 299534, title: 'Avengers: Endgame' });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(
      listRequestsTool.input.parse({ includeTitles: true }),
      ctx,
    );

    expect(service.getMovie).toHaveBeenCalledTimes(1);
    expect(result.requests[1]).toMatchObject({
      requestId: 55,
      requestStatus: { label: 'approved' },
    });
    expect(result.requests[1]?.title).toBeUndefined();
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toBe('Titles unavailable for 1 request with no tmdbId.');
    expect(notice).not.toContain('failed');
  });

  /** Truncation and hydration both write the shared `notice` field — neither may swallow the other. */
  it('composes the pagination hint and the hydration disclosure into one notice', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 9 },
      results: [requestRow(47, 'movie', 299534), requestRow(52, 'movie', null)],
    });
    service.getMovie.mockResolvedValue({ id: 299534, title: 'Avengers: Endgame' });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    await listRequestsTool.handler(
      listRequestsTool.input.parse({ take: 2, includeTitles: true }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toBe(
      'Results capped at 2; showing 2 of 9. Raise take or page with skip. Titles unavailable for 1 request with no tmdbId.',
    );
  });

  /** All three disclosures at once — capped page, a failed lookup, and an unhydratable row. */
  it('carries truncation, a failed lookup, and a missing tmdbId in one notice', async () => {
    service.listRequests.mockResolvedValue({
      pageInfo: { results: 12 },
      results: [
        requestRow(47, 'movie', 299534),
        requestRow(53, 'movie', 404404),
        requestRow(52, 'movie', null),
      ],
    });
    service.getMovie.mockImplementation(async (tmdbId: number) => {
      if (tmdbId === 404404) throw new Error('Unable to retrieve movie.');
      return { id: tmdbId, title: 'Avengers: Endgame' };
    });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    const result = await listRequestsTool.handler(
      listRequestsTool.input.parse({ take: 3, includeTitles: true }),
      ctx,
    );

    expect(result.requests.map((r) => r.title)).toEqual([
      'Avengers: Endgame',
      undefined,
      undefined,
    ]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toBe(
      'Results capped at 3; showing 3 of 12. Raise take or page with skip. ' +
        'Title lookup failed for 1 request; those rows keep every other field. ' +
        'Titles unavailable for 1 request with no tmdbId.',
    );
  });

  it('formats with request IDs, decoded status, and redacted requester', () => {
    const blocks = listRequestsTool.format!({
      requests: [
        {
          requestId: 45,
          mediaType: 'movie',
          tmdbId: 1275779,
          requestStatus: { raw: 2, label: 'approved' },
          is4k: false,
          requestedBy: { id: 1, displayName: 'mediauser' },
          createdAt: '2026-06-08T10:50:48.000Z',
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Request #45');
    expect(text).toContain('approved (2)');
    expect(text).toContain('mediauser');
  });

  it('keeps a hydrated title holding a line break in one heading', () => {
    const blocks = listRequestsTool.format!({
      requests: [
        {
          requestId: 45,
          mediaType: 'movie',
          title: 'Line\nBreak',
          tmdbId: 1275779,
          requestStatus: { raw: 2, label: 'approved' },
          is4k: false,
          requestedBy: { id: 1, displayName: 'mediauser' },
          createdAt: '2026-06-08T10:50:48.000Z',
        },
      ],
    });
    expect(readHeadings((blocks[0] as { text: string }).text)).toEqual([
      'Request #45 — Line\nBreak (movie, 4K=false)',
    ]);
  });

  it('escapes the upstream createdAt string', () => {
    const blocks = listRequestsTool.format!({
      requests: [
        {
          requestId: 46,
          mediaType: 'movie',
          tmdbId: 1,
          requestStatus: { raw: 1, label: 'pending' },
          is4k: false,
          requestedBy: { id: 1, displayName: 'mediauser' },
          createdAt: '2026 *x*',
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Created:** 2026 \\*x\\*');
  });
});

describe('seerr_list_requests — sort direction and older instances', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.unstubAllGlobals();
    live = undefined;
  });

  /** The service decides what reaches the wire; the tool hands it the caller's choice as given. */
  it.each([
    [{}, 'desc'],
    [{ sortDirection: 'asc' }, 'asc'],
  ])('passes sortDirection %j to the service as %s', async (args, direction) => {
    service.listRequests.mockResolvedValue({ pageInfo: { results: 0 }, results: [] });
    await listRequestsTool.handler(
      listRequestsTool.input.parse(args),
      createMockContext({ tenantId: 'test', errors: listRequestsTool.errors }),
    );
    expect(service.listRequests).toHaveBeenCalledWith(
      expect.objectContaining({ sortDirection: direction }),
      expect.anything(),
    );
  });

  /**
   * The default `desc` never reaches the wire, yet every upstream orders newest
   * first without it — so the echo reports the direction the caller got.
   */
  it('echoes the applied sort direction on both surfaces', async () => {
    service.listRequests.mockResolvedValue({ pageInfo: { results: 0 }, results: [] });
    const ctx = createMockContext({ tenantId: 'test', errors: listRequestsTool.errors });
    await listRequestsTool.handler(listRequestsTool.input.parse({}), ctx);
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      filter: 'all',
      mediaType: 'all',
      sort: 'added',
      sortDirection: 'desc',
    });

    const result = await runToolContract(listRequestsTool, { sortDirection: 'asc' });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { sortDirection: 'asc' },
    });
    expect(JSON.stringify(result.content)).toContain(
      '**Filters:** status=all, media=all, sort=added asc',
    );
  });

  /** Each echoed field is set off its default, so none can pass as a hard-coded default. */
  it('echoes non-default filter, mediaType, sort, and sortDirection on both surfaces', async () => {
    service.listRequests.mockResolvedValue({ pageInfo: { results: 0 }, results: [] });
    const result = await runToolContract(listRequestsTool, {
      filter: 'pending',
      mediaType: 'tv',
      sort: 'modified',
      sortDirection: 'asc',
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { appliedFilters: unknown }).appliedFilters).toEqual({
      filter: 'pending',
      mediaType: 'tv',
      sort: 'modified',
      sortDirection: 'asc',
    });
    expect(contentText(result)).toContain(
      '**Filters:** status=pending, media=tv, sort=modified asc',
    );
  });

  it('names the default desc direction in the content[] filters line', async () => {
    service.listRequests.mockResolvedValue({ pageInfo: { results: 0 }, results: [] });
    const result = await runToolContract(listRequestsTool, {});

    expect(result.isError).toBeFalsy();
    expect(contentText(result)).toContain('**Filters:** status=all, media=all, sort=added desc');
  });

  it('maps a 400 from Seerr to unsupported_filter with recovery on both result surfaces', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          message: "Unknown query parameter 'mediaType'",
          errors: [{ path: '.query.mediaType', message: "Unknown query parameter 'mediaType'" }],
        },
        { status: 400 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    live = new seerrModule.SeerrService();

    const result = await runToolContract(listRequestsTool, { mediaType: 'movie' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'unsupported_filter', retryable: false },
      },
    });
    const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
      .error.data.recovery.hint;
    expect(hint).toBe(UNSUPPORTED_FILTER_RECOVERY);
    expect(contentText(result)).toContain(`Recovery: ${UNSUPPORTED_FILTER_RECOVERY}`);
    expect(JSON.stringify(result)).not.toContain('Unknown query parameter');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('states which upstream versions accept asc, movie/tv, and the newer filters', () => {
    const { shape } = listRequestsTool.input;
    expect(shape.sortDirection.description).toMatch(/Jellyseerr 2\.2\+.*Overseerr/);
    expect(shape.mediaType.description).toMatch(/Jellyseerr 2\.6\+.*Overseerr/);
    expect(shape.filter.description).toMatch(/Overseerr 1\.35\+/);
    expect(listRequestsTool.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'unsupported_filter',
          code: JsonRpcErrorCode.InvalidParams,
        }),
      ]),
    );
  });
});
