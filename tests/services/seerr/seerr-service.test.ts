/**
 * @fileoverview Tests for SeerrService, mocking global `fetch`. The service checks
 * `response.ok` and routes non-OK responses through the not-found classifier — so a
 * mocked non-OK Response MUST drive the throwing error path (it does, via the
 * service's `request()` pipeline). Covers: 500 "Unable to retrieve movie." →
 * media_not_found (NotFound), 404 "Request not found." → request_not_found
 * (NotFound), the X-Api-Key header, the settings cache, and the wire form of
 * every query string (Seerr rejects reserved characters it sees undecoded).
 * @module tests/services/seerr/seerr-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSeerrService, initSeerrService } from '@/services/seerr/seerr-service.js';

// The service reads its env config via getServerConfig() at construction.
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    baseUrl: 'http://seerr.test:5055',
    apiKey: 'TEST-API-KEY',
    requestTimeoutMs: 15000,
  }),
}));

/** Build a JSON Response with the given status — mirrors how the live API replies. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

describe('SeerrService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    initSeerrService({} as AppConfig, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the X-Api-Key header and appends /api/v1 to the base URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { page: 1, totalResults: 0, results: [] }));
    const ctx = createMockContext({ tenantId: 'test' });
    await getSeerrService().search({ query: 'Mulan', page: 1 }, ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://seerr.test:5055/api/v1/search?query=Mulan&page=1');
    expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe('TEST-API-KEY');
  });

  /**
   * Seerr validates the UNDECODED query string against
   * `/[:\/?#\[\]@!$&'()*+,;=]/` and 400s on a match, so the wire form is the only
   * thing that matters here. `URLSearchParams` emits `+` for a space and
   * `encodeURIComponent` leaves `!'()*` bare — both trip the check.
   */
  describe.each([
    ['space', 'Avengers Doomsday', 'Avengers%20Doomsday'],
    ['apostrophe', "Ocean's Eleven", 'Ocean%27s%20Eleven'],
    ['parentheses + hyphen', 'WALL-E (2008)', 'WALL-E%20%282008%29'],
    ['asterisk', 'M*A*S*H', 'M%2AA%2AS%2AH'],
    ['exclamation', 'Mamma Mia!', 'Mamma%20Mia%21'],
    [
      'ampersand, comma, colon, slash',
      'Fast & Furious: Tokyo, 1/2',
      'Fast%20%26%20Furious%3A%20Tokyo%2C%201%2F2',
    ],
    ['plus, equals, semicolon, hash, dollar', 'A+B=C;D#E$F', 'A%2BB%3DC%3BD%23E%24F'],
    ['brackets and at-sign', '[REC] @home', '%5BREC%5D%20%40home'],
    ['question mark', 'Who Framed Roger Rabbit?', 'Who%20Framed%20Roger%20Rabbit%3F'],
  ])('percent-encodes the query — %s', (_label, query, encoded) => {
    it(`sends ${encoded}`, async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { page: 1, totalResults: 0, results: [] }));
      const ctx = createMockContext({ tenantId: 'test' });
      await getSeerrService().search({ query, page: 1 }, ctx);

      const [url] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(`http://seerr.test:5055/api/v1/search?query=${encoded}&page=1`);
      // No reserved character survives undecoded in the value Seerr inspects.
      const value = String(url).split('?')[1]!.split('&')[0]!.slice('query='.length);
      expect(value).not.toMatch(/[:/?#[\]@!$&'()*+,;=]/);
    });
  });

  it('percent-encodes the optional language param and preserves param order', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { page: 1, totalResults: 0, results: [] }));
    const ctx = createMockContext({ tenantId: 'test' });
    await getSeerrService().search({ query: 'Amélie', page: 2, language: 'fr-FR' }, ctx);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://seerr.test:5055/api/v1/search?query=Am%C3%A9lie&page=2&language=fr-FR',
    );
  });

  it('builds the request-list query through the same encoder, omitting mediaType:all', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { pageInfo: {}, results: [] }));
    const ctx = createMockContext({ tenantId: 'test' });
    await getSeerrService().listRequests(
      {
        take: 10,
        skip: 0,
        filter: 'all',
        sort: 'added',
        sortDirection: 'desc',
        mediaType: 'all',
        requestedById: 7,
      },
      ctx,
    );

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://seerr.test:5055/api/v1/request?take=10&skip=0&filter=all&sort=added&sortDirection=desc&requestedBy=7',
    );
  });

  it('classifies a 500 "Unable to retrieve movie." as media_not_found (NotFound) with a recovery hint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'Unable to retrieve movie.' }));
    const ctx = createMockContext({ tenantId: 'test' });

    // The classifier runs in the service layer (no ctx), so it attaches the
    // recovery hint at the throw site — the framework mirrors data.recovery.hint
    // into both wire surfaces. Without it, the most common error path (a bad TMDB
    // id) would surface no actionable next step.
    await expect(getSeerrService().getMovie(99999999999, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'media_not_found',
        retryable: false,
        recovery: { hint: expect.stringContaining('seerr_search_media') },
      },
    });
  });

  it('classifies a 404 "Request not found." as request_not_found (NotFound) with a recovery hint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'Request not found.' }));
    const ctx = createMockContext({ tenantId: 'test' });

    await expect(getSeerrService().getRequest(999999, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'request_not_found',
        retryable: false,
        recovery: { hint: expect.stringContaining('seerr_list_requests') },
      },
    });
  });

  it('throws (does not return) on a generic non-OK response', async () => {
    // A 503 with no recognized not-found body bubbles as a thrown error via the
    // framework status mapping — the service never returns a non-OK Response.
    fetchMock.mockResolvedValue(jsonResponse(503, { message: 'temporarily down' }));
    const ctx = createMockContext({ tenantId: 'test' });

    await expect(getSeerrService().getStatus(ctx)).rejects.toBeDefined();
  });

  /**
   * The unclassified-status fallback is the one error path that leaves the service
   * without passing through `normalizers.ts`, so it is also the one that could put
   * the instance's host:port on a client-facing surface. `error.data` is forwarded
   * verbatim as `structuredContent.error.data`, so nothing here may name the base
   * URL or the API key. A 403 is chosen because it is non-transient — one attempt,
   * no retry budget spent.
   */
  it('puts neither the upstream URL nor the API key on a generic non-OK error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { message: 'forbidden' }));
    const ctx = createMockContext({ tenantId: 'test' });

    const error = await getSeerrService()
      .getStatus(ctx)
      .then(
        () => undefined,
        (err: unknown) => err as Error & { data?: Record<string, unknown> },
      );

    expect(error).toBeDefined();
    expect(error?.data).not.toHaveProperty('url');
    const serialized = `${error?.message} ${JSON.stringify(error?.data ?? {})}`;
    expect(serialized).not.toContain('seerr.test');
    expect(serialized).not.toContain('TEST-API-KEY');
  });

  /**
   * A 503 classifies as transient, so the default budget spends four attempts on
   * it. That is right for a required read and wrong for a best-effort one — the
   * title join passes `maxRetries: 0` precisely to opt out, so the service has to
   * actually honor the override rather than accept and ignore it.
   */
  it('retries a transient detail read by default and once only when maxRetries is 0', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { message: 'temporarily down' }));
    const ctx = createMockContext({ tenantId: 'test' });

    await expect(getSeerrService().getMovie(550, ctx, { maxRetries: 0 })).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    await expect(getSeerrService().getTv(1399, ctx, { maxRetries: 0 })).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    await expect(getSeerrService().getMovie(550, ctx)).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 20_000);

  it('parses and returns a successful movie detail payload', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: 1275779, title: 'Disclosure Day', runtime: 145 }),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    const movie = await getSeerrService().getMovie(1275779, ctx);
    expect(movie).toMatchObject({ id: 1275779, title: 'Disclosure Day' });
  });

  it('caches /settings/public — a second call does not re-fetch', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { movie4kEnabled: true, mediaServerType: 2 }),
    );
    const ctx = createMockContext({ tenantId: 'test' });

    const first = await getSeerrService().getPublicSettings(ctx);
    const second = await getSeerrService().getPublicSettings(ctx);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  /**
   * `ctx.state` rejects any key outside `[a-zA-Z0-9_.\-/]`, and both cache calls
   * swallow their own failure — so a non-conforming key degrades to a silent miss on
   * every call rather than an error. Assert the value actually landed in state, not
   * merely that a second call skipped the network.
   */
  it('writes the settings cache under a storage-legal key', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { movie4kEnabled: true, mediaServerType: 2 }),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    await getSeerrService().getPublicSettings(ctx);

    const { items } = await ctx.state.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toMatch(/^[a-zA-Z0-9_./-]+$/);
    await expect(ctx.state.get(items[0]!.key)).resolves.toMatchObject({ movie4kEnabled: true });
  });

  it('re-fetches /settings/public on forceRefresh', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { movie4kEnabled: true, mediaServerType: 2 }),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    await getSeerrService().getPublicSettings(ctx);
    await getSeerrService().getPublicSettings(ctx, { forceRefresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
