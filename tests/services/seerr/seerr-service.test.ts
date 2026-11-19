/**
 * @fileoverview Tests for SeerrService, mocking global `fetch`. The service checks
 * `response.ok` and routes non-OK responses through the not-found classifier — so a
 * mocked non-OK Response MUST drive the throwing error path (it does, via the
 * service's `request()` pipeline). Covers: 500 "Unable to retrieve movie." or
 * "…series." → media_not_found (NotFound), a season read's 500 "Unable to retrieve
 * season." → season_not_found (NotFound), 404 "Request not found." →
 * request_not_found (NotFound), the generic mapping outside each classified shape,
 * no upstream body on an unclassified error, the X-Api-Key header, the settings
 * cache, and the wire form of every query string (Seerr rejects reserved
 * characters it sees undecoded).
 * @module tests/services/seerr/seerr-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
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

  /**
   * Overseerr and Jellyseerr < 2.2 reject `sortDirection` as an unknown query key,
   * and every upstream already orders newest first without it — so the default
   * `desc` stays off the wire and only `asc` is sent.
   */
  it('builds the request-list query through the same encoder, omitting mediaType:all and the default sortDirection', async () => {
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
      'http://seerr.test:5055/api/v1/request?take=10&skip=0&filter=all&sort=added&requestedBy=7',
    );
  });

  it('forwards sortDirection only when it is asc, and mediaType when it is movie or tv', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { pageInfo: {}, results: [] }));
    const ctx = createMockContext({ tenantId: 'test' });
    await getSeerrService().listRequests(
      {
        take: 20,
        skip: 40,
        filter: 'pending',
        sort: 'modified',
        sortDirection: 'asc',
        mediaType: 'movie',
      },
      ctx,
    );
    await getSeerrService().listRequests(
      { take: 20, skip: 0, filter: 'all', sort: 'added', sortDirection: 'desc', mediaType: 'tv' },
      ctx,
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://seerr.test:5055/api/v1/request?take=20&skip=40&filter=pending&sort=modified&sortDirection=asc&mediaType=movie',
      'http://seerr.test:5055/api/v1/request?take=20&skip=0&filter=all&sort=added&mediaType=tv',
    ]);
  });

  /**
   * `GET /request` takes no body, so its 400 is always a rejected query parameter
   * from an instance older than the input it was sent. The validator's body names
   * the parameter, but Seerr error bodies never reach output.
   */
  it('maps a 400 from GET /request to unsupported_filter without echoing the upstream body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        message: "Unknown query parameter 'sortDirection'",
        errors: [
          { path: '.query.sortDirection', message: "Unknown query parameter 'sortDirection'" },
        ],
      }),
    );
    const ctx = createMockContext({ tenantId: 'test' });

    const error = await getSeerrService()
      .listRequests(
        { take: 20, skip: 0, filter: 'all', sort: 'added', sortDirection: 'asc', mediaType: 'all' },
        ctx,
      )
      .then(
        () => undefined,
        (err: unknown) => err as Error & { code?: number; data?: Record<string, unknown> },
      );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'unsupported_filter', httpStatus: 400, retryable: false },
    });
    expect(`${error?.message} ${JSON.stringify(error?.data)}`).not.toContain('Unknown query');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('leaves a 400 from any other endpoint generic', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { message: 'bad' }));
    const ctx = createMockContext({ tenantId: 'test' });

    const error = await getSeerrService()
      .getStatus(ctx)
      .then(
        () => undefined,
        (err: unknown) => err as { code?: number; data?: Record<string, unknown> },
      );
    expect(error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error?.data).not.toHaveProperty('reason');
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

  it('classifies a show read\'s 500 "Unable to retrieve series." as media_not_found, unretried', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'Unable to retrieve series.' }));
    const ctx = createMockContext({ tenantId: 'test' });

    await expect(getSeerrService().getTv(404404, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'media_not_found', httpStatus: 500, retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  /**
   * Seerr answers `GET /tv/{id}/season/{n}` for a season TMDB doesn't have with
   * HTTP 500 `{"message":"Unable to retrieve season."}`. By status alone that is a
   * retryable outage; the season read's own endpoint tag makes it a final not-found.
   */
  it('classifies a season read\'s 500 "Unable to retrieve season." as season_not_found, unretried', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'Unable to retrieve season.' }));
    const ctx = createMockContext({ tenantId: 'test' });

    await expect(getSeerrService().getSeason(1399, 99, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'season_not_found', httpStatus: 500, retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://seerr.test:5055/api/v1/tv/1399/season/99',
    );
  });

  /**
   * Each classified shape keys on endpoint, status, and body together. A shape's
   * status from another endpoint, its body at another status, and another body at
   * its status all keep the status-based mapping, with no reason attached.
   */
  describe('outside every classified shape', () => {
    type Read = (ctx: Context) => Promise<unknown>;
    const listAll: Read = (ctx) =>
      getSeerrService().listRequests(
        {
          take: 20,
          skip: 0,
          filter: 'all',
          sort: 'added',
          sortDirection: 'desc',
          mediaType: 'all',
        },
        ctx,
      );
    const readRequest: Read = (ctx) => getSeerrService().getRequest(45, ctx);
    const readMovie: Read = (ctx) => getSeerrService().getMovie(550, ctx, { maxRetries: 0 });
    const readSeason: Read = (ctx) => getSeerrService().getSeason(1399, 99, ctx);

    it.each<[string, Read, number, string, number]>([
      ['a 409 from GET /request', listAll, 409, 'conflict', JsonRpcErrorCode.Conflict],
      ['a 409 from GET /request/{id}', readRequest, 409, 'conflict', JsonRpcErrorCode.Conflict],
      [
        'a movie read 500 with a generic body',
        readMovie,
        500,
        'Internal Server Error',
        JsonRpcErrorCode.ServiceUnavailable,
      ],
      [
        'a request read 404 with a generic body',
        readRequest,
        404,
        'Not Found',
        JsonRpcErrorCode.NotFound,
      ],
      [
        'a movie read 500 with the season body',
        readMovie,
        500,
        'Unable to retrieve season.',
        JsonRpcErrorCode.ServiceUnavailable,
      ],
      [
        'a season read 404 with the season body',
        readSeason,
        404,
        'Unable to retrieve season.',
        JsonRpcErrorCode.NotFound,
      ],
      [
        'a season read 500 with a generic body',
        readSeason,
        500,
        'Internal Server Error',
        JsonRpcErrorCode.ServiceUnavailable,
      ],
    ])('keeps %s generic', async (_label, read, status, message, code) => {
      vi.useFakeTimers();
      try {
        fetchMock.mockImplementation(async () => jsonResponse(status, { message }));
        const outcome = read(createMockContext({ tenantId: 'test' })).then(
          () => undefined,
          (err: unknown) => err as { code?: number; data?: Record<string, unknown> },
        );
        await vi.runAllTimersAsync();
        const error = await outcome;

        expect(error?.code).toBe(code);
        expect(error?.data).not.toHaveProperty('reason');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('throws (does not return) on a generic non-OK response', async () => {
    // A 503 with no recognized not-found body bubbles as a thrown error via the
    // framework status mapping — the service never returns a non-OK Response.
    fetchMock.mockResolvedValue(jsonResponse(503, { message: 'temporarily down' }));
    const ctx = createMockContext({ tenantId: 'test' });

    await expect(getSeerrService().getStatus(ctx)).rejects.toBeDefined();
  });

  it.each(['503', 'network', 'invalid-json'])(
    'does not retry a non-idempotent request POST after %s failure',
    async (failure) => {
      vi.useFakeTimers();
      try {
        fetchMock.mockImplementation(async () => {
          if (failure === 'network') throw new TypeError('fetch failed');
          if (failure === 'invalid-json') return new Response('{', { status: 200 });
          return jsonResponse(503, { message: 'temporarily down' });
        });
        const ctx = createMockContext({ tenantId: 'test' });
        const outcome = getSeerrService()
          .createRequest({ mediaType: 'movie', mediaId: 1275779, is4k: false }, ctx)
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await vi.runAllTimersAsync();

        expect(await outcome).toBeDefined();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST');
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
   * Radarr and Sonarr error strings Seerr relays can name an internal service URL
   * or a root-folder path, so the unclassified fallback carries no upstream body —
   * not in the message, and not in `data`, where a captured body would land.
   */
  it('keeps an unclassified error body, and the infrastructure it names, off the thrown error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(502, {
        message:
          'Radarr at http://10.0.0.5:7878 refused the add: root folder /mnt/media/movies is not writable',
      }),
    );
    const ctx = createMockContext({ tenantId: 'test' });

    const error = await getSeerrService()
      .getMovie(550, ctx, { maxRetries: 0 })
      .then(
        () => undefined,
        (err: unknown) => err as Error & { code?: number; data?: Record<string, unknown> },
      );

    expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    const serialized = `${error?.message} ${JSON.stringify(error?.data ?? {})}`;
    expect(serialized).not.toContain('10.0.0.5:7878');
    expect(serialized).not.toContain('/mnt/media/movies');
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

  /**
   * `POST /request` answers 201 with the new `MediaRequest`, 409 for a same-quality
   * duplicate, and 202 when every requested season is already requested or
   * available — each with a `{ message }` body and no request ID. Only the 201
   * creates anything, so only a body carrying a numeric `id` may come back.
   */
  describe('createRequest', () => {
    const body = { mediaType: 'tv' as const, mediaId: 1399, is4k: false, seasons: [1] };

    /** Settle the POST and return its outcome, keeping the mocked fetch's call log. */
    const submit = () =>
      getSeerrService()
        .createRequest(body, createMockContext({ tenantId: 'test' }))
        .then(
          (value) => ({ value }),
          (error: Error & { code?: number; data?: Record<string, unknown> }) => ({ error }),
        );

    it('returns the created request on a 201', async () => {
      fetchMock.mockResolvedValue(jsonResponse(201, { id: 601, status: 2, media: { status: 3 } }));
      expect(await submit()).toEqual({ value: { id: 601, status: 2, media: { status: 3 } } });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('maps a 409 to duplicate_request without echoing the upstream body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, { message: 'Request for this media already exists.' }),
      );
      const { error } = (await submit()) as { error: Error & { data?: object } };

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'duplicate_request', httpStatus: 409, retryable: false },
      });
      expect(`${error.message} ${JSON.stringify(error.data)}`).not.toContain('for this media');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('refuses a 202 as no_seasons_available instead of returning its body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(202, { message: 'No seasons available to request' }),
      );
      const { error } = (await submit()) as { error: Error & { data?: object } };

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'no_seasons_available', httpStatus: 202, retryable: false },
      });
      expect(`${error.message} ${JSON.stringify(error.data)}`).not.toContain(
        'No seasons available',
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    /**
     * Seerr 3.5+ expands `"all"` to the numbered seasons whose `episode_count > 0`, so
     * an announced show with no episodes listed also answers 202 — nothing in it is
     * requested or available, and the message must not say otherwise.
     */
    it('names the no-episodes case in the 202 message', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(202, { message: 'No seasons available to request' }),
      );
      const { error } = (await submit()) as { error: Error };

      expect(error.message).toContain('already requested or available');
      expect(error.message).toContain('no episodes');
    });

    it.each([
      ['a body with no id', () => jsonResponse(201, { status: 1 })],
      ['a non-numeric id', () => jsonResponse(201, { id: '601', status: 1 })],
      ['an empty body', () => new Response(null, { status: 201 })],
      ['a JSON null', () => jsonResponse(200, null)],
    ])('never returns a 2xx answer carrying %s', async (_label, respond) => {
      fetchMock.mockImplementation(async () => respond());
      const { error } = (await submit()) as { error: Error & { data?: object } };

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        data: { recovery: { hint: expect.stringContaining('seerr_get_media') } },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    /** Seerr's OpenAPI validator answers a malformed body with a 400 here. */
    it.each([
      [400, JsonRpcErrorCode.InvalidParams],
      [403, JsonRpcErrorCode.Forbidden],
      [500, JsonRpcErrorCode.ServiceUnavailable],
    ])('keeps a %i on the POST classified by status alone', async (status, code) => {
      fetchMock.mockResolvedValue(jsonResponse(status, { message: 'Request refused.' }));
      const { error } = (await submit()) as { error: { code?: number; data?: object } };

      expect(error.code).toBe(code);
      expect(error.data).not.toHaveProperty('reason');
    });

    it('leaves a 409 from a read endpoint generic', async () => {
      fetchMock.mockResolvedValue(jsonResponse(409, { message: 'conflict' }));
      const error = await getSeerrService()
        .getStatus(createMockContext({ tenantId: 'test' }))
        .then(
          () => undefined,
          (err: unknown) => err as { code?: number; data?: Record<string, unknown> },
        );
      expect(error?.code).toBe(JsonRpcErrorCode.Conflict);
      expect(error?.data).not.toHaveProperty('reason');
    });
  });
});
