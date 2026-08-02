/**
 * @fileoverview Tests for seerr_list_requests. Headline: list recent requests with
 * decoded statuses and a PII-redacted requester. Covers: type→mediaType mapping,
 * media.tmdbId/status projection, requester redaction, totalCount from
 * pageInfo.results, the empty-result notice, format rendering, and the opt-in
 * includeTitles hydration path (default cost, dedupe, and both degrade modes).
 * @module tests/tools/list-requests.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = { listRequests: vi.fn(), getMovie: vi.fn(), getTv: vi.fn() };

vi.mock('@/services/seerr/seerr-service.js', () => ({ getSeerrService: () => service }));

const { listRequestsTool } = await import('@/mcp-server/tools/definitions/list-requests.tool.js');

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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
    const ctx = createMockContext({ tenantId: 'test' });
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
});
