/**
 * @fileoverview Tests for seerr_request_media — the guarded 2-step write. Mocks
 * SeerrService so the handler logic (preview vs request, the confirmation round,
 * local capability validation, duplicate detection, redaction) is exercised
 * deterministically. The headline guarantees verified literally: preview NEVER
 * writes; a real write happens ONLY after the handler is re-entered with a
 * schema-valid acceptance; a declined, cancelled, or unparseable response cancels
 * with no write; and there is no branch that proceeds without an acceptance.
 * @module tests/tools/request-media.tool.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawMediaRequestDetail, SeerrService } from '@/services/seerr/seerr-service.js';
import type {
  RawMediaRequest,
  RawMovieDetail,
  RawPublicSettings,
  RawTvDetail,
} from '@/services/seerr/types.js';
import { readHeadings } from '../helpers/commonmark.js';

const settings: RawPublicSettings = {
  movie4kEnabled: true,
  series4kEnabled: true,
  partialRequestsEnabled: true,
  enableSpecialEpisodes: false,
};

const movie: RawMovieDetail = {
  id: 1275779,
  title: 'Disclosure Day',
  releaseDate: '2026-06-10',
};

const tv: RawTvDetail = {
  id: 1399,
  name: 'Game of Thrones',
  firstAirDate: '2011-04-17',
};

const createdRequest: RawMediaRequestDetail = { id: 501, status: 1, media: { status: 2 } };

const service = {
  getPublicSettings: vi.fn(async (): Promise<RawPublicSettings> => settings),
  getMovie: vi.fn(async (): Promise<RawMovieDetail> => movie),
  getTv: vi.fn(async (): Promise<RawTvDetail> => tv),
  createRequest: vi.fn(async (): Promise<RawMediaRequestDetail> => createdRequest),
};

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    baseUrl: 'http://seerr.test:5055',
    apiKey: 'TEST-API-KEY',
    requestTimeoutMs: 15000,
  }),
}));

/**
 * Most suites drive the handler against the `service` stub. The cases about how
 * Seerr answers the POST set `live` to a real SeerrService over a mocked `fetch`,
 * so the upstream status travels the service's own classification into the handler.
 */
let live: SeerrService | undefined;

vi.mock('@/services/seerr/seerr-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/seerr/seerr-service.js')>()),
  getSeerrService: () => live ?? service,
}));

const seerrModule = await import('@/services/seerr/seerr-service.js');
const { requestMediaTool } = await import('@/mcp-server/tools/definitions/request-media.tool.js');

/** The `mode: request` arm at the given quality, parsed through the tool's own input schema. */
const requestMovieInput = (is4k = false) =>
  requestMediaTool.input.parse({ mediaType: 'movie', tmdbId: 1275779, mode: 'request', is4k });

/** A TV `mode: request` call for season 1. */
const requestTvInput = () =>
  requestMediaTool.input.parse({ mediaType: 'tv', tmdbId: 1399, mode: 'request', seasons: [1] });

/** The error a handler call rejects with; fails the test when the call succeeds. */
const rejectionOf = async (run: () => unknown): Promise<McpError> => {
  try {
    await run();
  } catch (error) {
    return error as McpError;
  }
  throw new Error('Expected the handler to reject.');
};

/** Seeds the second round with whatever the client sent back for the confirmation key. */
const roundTwo = async (response: unknown, input = requestMovieInput()) => {
  const first = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
  const asked = await expectInputRequired(() => requestMediaTool.handler(input, first));
  const ctx = createMockContext({
    tenantId: 'test',
    errors: requestMediaTool.errors,
    inputResponses: { confirm: response },
    requestState: asked.requestState,
  });
  const record = await first.state.get(`consent/${asked.requestState}`);
  if (record) await ctx.state.set(`consent/${asked.requestState}`, record, { ttl: 600 });
  return ctx;
};

describe('seerr_request_media — preview (default, no write)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getPublicSettings.mockResolvedValue(settings);
    service.getMovie.mockResolvedValue(movie);
    service.createRequest.mockResolvedValue(createdRequest);
  });

  it('resolves and returns the payload that WOULD be submitted, writing nothing', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({ mediaType: 'movie', tmdbId: 1275779 });
    const result = await requestMediaTool.handler(input, ctx);

    expect(result.mode).toBe('preview');
    expect(result.resolved).toMatchObject({ tmdbId: 1275779, title: 'Disclosure Day' });
    expect(result.payload).toMatchObject({ mediaType: 'movie', mediaId: 1275779, is4k: false });
    expect(result.created).toBeUndefined();
    // The headline guarantee: NO write on preview.
    expect(service.createRequest).not.toHaveBeenCalled();
  });
});

describe('seerr_request_media — request (guarded write)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getPublicSettings.mockResolvedValue(settings);
    service.getMovie.mockResolvedValue(movie);
    service.getTv.mockResolvedValue(tv);
    service.createRequest.mockResolvedValue(createdRequest);
  });

  it('suspends on an input-required round instead of writing, naming the resolved title', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const asked = await expectInputRequired(() =>
      requestMediaTool.handler(requestMovieInput(), ctx),
    );

    expect(asked.inputRequests?.confirm?.method).toBe('elicitation/create');
    // Consent is scoped to the specific target, not a generic "proceed?".
    expect(JSON.stringify(asked.inputRequests?.confirm)).toContain('Disclosure Day');
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('carries the season summary into the confirmation message for a TV request', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'tv',
      tmdbId: 1399,
      mode: 'request',
      seasons: [1, 2],
    });
    const asked = await expectInputRequired(() => requestMediaTool.handler(input, ctx));

    const message = JSON.stringify(asked.inputRequests?.confirm);
    expect(message).toContain('Game of Thrones');
    expect(message).toContain('seasons 1, 2');
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('writes ONLY once re-entered with a schema-valid acceptance', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
    const result = await requestMediaTool.handler(requestMovieInput(), ctx);

    expect(service.createRequest).toHaveBeenCalledOnce();
    expect(result.created).toMatchObject({
      requestId: 501,
      requestStatus: { raw: 1, label: 'pending' },
      mediaStatus: { raw: 2, label: 'pending' },
    });
  });

  it('asks again for a pre-answered acceptance without a server record', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: requestMediaTool.errors,
      inputResponses: { confirm: { action: 'accept', content: { confirmed: true } } },
    });
    await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it.each([{ tmdbId: 42 }, { is4k: true }, { rootFolder: '/changed' }, { profileId: 2 }])(
    'asks again when the confirmed target or payload changes: %j',
    async (change) => {
      const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
      await expectInputRequired(() =>
        requestMediaTool.handler({ ...requestMovieInput(), ...change }, ctx),
      );
      expect(service.createRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['operation', 'clientId', 'subject', 'contentHash'])(
    'asks again for a mismatched %s',
    async (field) => {
      const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
      const key = `consent/${ctx.inputs.state()}`;
      const record = await ctx.state.get(key);
      await ctx.state.set(key, { ...(record as object), [field]: 'changed' });
      await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
      expect(service.createRequest).not.toHaveBeenCalled();
    },
  );

  it('spends the record before a sequential replay', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
    await requestMediaTool.handler(requestMovieInput(), ctx);
    await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
    expect(service.createRequest).toHaveBeenCalledOnce();
  });

  it('asks again for a different authenticated caller', async () => {
    const original = await roundTwo({ action: 'accept', content: { confirmed: true } });
    const ctx = createMockContext({
      tenantId: 'test',
      errors: requestMediaTool.errors,
      requestState: original.inputs.state(),
      inputResponses: { confirm: { action: 'accept', content: { confirmed: true } } },
      auth: { clientId: 'other-client', sub: 'other-user', scopes: [] },
    });
    const key = `consent/${original.inputs.state()}`;
    await ctx.state.set(key, await original.state.get(key));
    await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('asks again when resolved content changes after confirmation', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
    service.getMovie.mockResolvedValue({ ...movie, title: 'Changed title' });
    await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('asks again after the consent record expires', async () => {
    vi.useFakeTimers();
    try {
      const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
      vi.setSystemTime(Date.now() + 601_000);
      await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
      expect(service.createRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes an accepted round on both production-shaped result surfaces', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
    const result = await runToolContract(
      {
        ...requestMediaTool,
        handler: (input) => requestMediaTool.handler(requestMediaTool.input.parse(input), ctx),
      },
      requestMovieInput(),
    );
    expect(result.structuredContent).toMatchObject({ created: { requestId: 501 } });
    expect(JSON.stringify(result.content)).toContain('Created request #501');
  });

  it('carries cancellation reason and recovery through the contract envelope', async () => {
    const ctx = await roundTwo({ action: 'cancel' });
    const result = await runToolContract(
      {
        ...requestMediaTool,
        handler: (input) => requestMediaTool.handler(requestMediaTool.input.parse(input), ctx),
      },
      requestMovieInput(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('request_cancelled');
    expect(JSON.stringify(result.content)).toContain('mode:request');
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('allows only one simultaneous redemption in this process', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
    const get = ctx.state.get.bind(ctx.state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ctx.state, 'get').mockImplementation(async (...args) => {
      await held;
      return get(...args);
    });
    const first = requestMediaTool.handler(requestMovieInput(), ctx);
    await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
    release();
    await first;
    expect(service.createRequest).toHaveBeenCalledOnce();
  });

  it('renders the created request through format() as well as structuredContent', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: true } });
    const result = await requestMediaTool.handler(requestMovieInput(), ctx);

    // Claude Code reads structuredContent; Claude Desktop reads content[]. Both carry it.
    expect(result.created?.requestId).toBe(501);
    const text = (requestMediaTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Created request #501');
    expect(text).toContain('Request submitted: Disclosure Day');
    expect(text).toContain('seerr_request_status');
  });

  it('does NOT write when the confirmation is declined (request_cancelled)', async () => {
    const ctx = await roundTwo({ action: 'decline' });
    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'request_cancelled',
        recovery: { hint: expect.stringContaining('mode:request') },
      },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('does NOT write when the confirmation is cancelled (request_cancelled)', async () => {
    const ctx = await roundTwo({ action: 'cancel' });
    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      data: { reason: 'request_cancelled' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  /**
   * The SDK never re-validates a response against the schema its request advertised,
   * so an "accepted" round carrying something else is untrusted input, not consent.
   */
  it('does NOT write on an accepted round whose content fails the confirmation schema', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: 'yes please' } });
    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      data: { reason: 'request_cancelled' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('does NOT write on an accepted round that explicitly withholds consent', async () => {
    const ctx = await roundTwo({ action: 'accept', content: { confirmed: false } });
    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      data: { reason: 'request_cancelled' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  /**
   * A client that never answers the round simply leaves the write un-run — there is
   * no "proceed anyway when the round is unavailable" branch to detect or exercise.
   * `destructiveHint` is what surfaces the risk in such a client's approval flow.
   */
  it('never writes for a client that does not answer, and keeps the destructiveHint signal', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));
    await expectInputRequired(() => requestMediaTool.handler(requestMovieInput(), ctx));

    expect(service.createRequest).not.toHaveBeenCalled();
    expect(requestMediaTool.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
      readOnlyHint: false,
    });
  });

  it('declares request_cancelled in the error contract with an actionable recovery', () => {
    expect(requestMediaTool.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'request_cancelled',
          code: JsonRpcErrorCode.InvalidParams,
          recovery: expect.stringContaining('mode:request'),
        }),
      ]),
    );
  });
});

describe('seerr_request_media — local validation before any write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getPublicSettings.mockResolvedValue(settings);
    service.getMovie.mockResolvedValue(movie);
    service.getTv.mockResolvedValue(tv);
  });

  it('rejects a TV request with no seasons (seasons_required) without writing', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({ mediaType: 'tv', tmdbId: 1399, mode: 'request' });
    await expect(requestMediaTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'seasons_required' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('rejects is4k when 4K is disabled for the media type (four_k_not_enabled)', async () => {
    service.getPublicSettings.mockResolvedValue({ ...settings, movie4kEnabled: false });
    service.getMovie.mockResolvedValue({ id: 1, title: 'X' });
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'movie',
      tmdbId: 1,
      mode: 'request',
      is4k: true,
    });
    await expect(requestMediaTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'four_k_not_enabled' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('rejects an explicit season list when partial requests are disabled (partial_requests_disabled)', async () => {
    service.getPublicSettings.mockResolvedValue({ ...settings, partialRequestsEnabled: false });
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'tv',
      tmdbId: 1399,
      mode: 'request',
      seasons: [1, 2],
    });
    await expect(requestMediaTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'partial_requests_disabled' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('rejects season 0 when the instance has special episodes disabled', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'tv',
      tmdbId: 1399,
      mode: 'request',
      seasons: [0, 1],
    });
    await expect(requestMediaTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'special_episodes_not_enabled',
        recovery: { hint: expect.stringContaining('seerr_service_options') },
      },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('accepts season 0 when the instance enables special episodes', async () => {
    service.getPublicSettings.mockResolvedValue({ ...settings, enableSpecialEpisodes: true });
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'tv',
      tmdbId: 1399,
      seasons: [0, 1],
    });
    const result = await requestMediaTool.handler(input, ctx);
    expect(result.payload.seasons).toEqual([0, 1]);
  });

  it('accepts seasons:[0] at the input schema (the gate is the handler, not the schema)', () => {
    expect(() =>
      requestMediaTool.input.parse({ mediaType: 'tv', tmdbId: 1399, seasons: [0] }),
    ).not.toThrow();
  });

  /**
   * The schema no longer rejects season 0, so the handler gate is the only thing
   * standing between `[0]` and the upstream payload — it has to fire on the preview
   * arm too, not just the arm that writes.
   */
  it('rejects season 0 on the preview arm as well as the request arm', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'tv',
      tmdbId: 1399,
      mode: 'preview',
      seasons: [0],
    });
    await expect(requestMediaTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'special_episodes_not_enabled' },
    });
  });

  /**
   * `seasons` is documented as ignored for movies and `buildPayload` drops it, so a
   * movie carrying one must not trip a season constraint it cannot violate.
   */
  it('ignores a season list on a movie instead of raising a season constraint', async () => {
    service.getPublicSettings.mockResolvedValue({
      ...settings,
      partialRequestsEnabled: false,
      enableSpecialEpisodes: false,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'movie',
      tmdbId: 1275779,
      seasons: [0, 1],
    });
    const result = await requestMediaTool.handler(input, ctx);
    expect(result.payload).not.toHaveProperty('seasons');
  });

  it('allows seasons:"all" even when partial requests are disabled', async () => {
    service.getPublicSettings.mockResolvedValue({ ...settings, partialRequestsEnabled: false });
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'tv',
      tmdbId: 1399,
      mode: 'preview',
      seasons: 'all',
    });
    const result = await requestMediaTool.handler(input, ctx);
    expect(result.payload.seasons).toBe('all');
  });

  /** Without its own message, `ctx.fail` falls back to the contract's lowercase `when` clause. */
  it.each([
    ['seasons_required', {}, {}, 'A TV request needs seasons, and none were given.'],
    [
      'partial_requests_disabled',
      { seasons: [1, 2] },
      { partialRequestsEnabled: false },
      'This instance does not allow requests for individual seasons, only for the whole series.',
    ],
  ])(
    '%s carries its own sentence-case message, not the contract when text',
    async (reason, args, patch, message) => {
      service.getPublicSettings.mockResolvedValue({ ...settings, ...patch });
      const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
      const input = requestMediaTool.input.parse({
        mediaType: 'tv',
        tmdbId: 1399,
        mode: 'request',
        ...args,
      });
      const error = await rejectionOf(() => requestMediaTool.handler(input, ctx));

      expect(error.data).toMatchObject({ reason });
      expect(error.message).toBe(message);
      expect(error.message).not.toBe(
        requestMediaTool.errors?.find((e) => e.reason === reason)?.when,
      );
      expect(service.createRequest).not.toHaveBeenCalled();
    },
  );

  it('describes seasons "all" as never including Specials and existingRequest as the latest request', () => {
    const seasons = requestMediaTool.input.shape.seasons.description ?? '';
    expect(seasons).not.toMatch(/decides/);
    expect(seasons).toContain('never season 0');
    expect(requestMediaTool.output.shape.existingRequest.description).toMatch(
      /^Latest request for this title/,
    );
  });
});

/** A JSON `Response`, the shape every Seerr endpoint answers with. */
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Stand up a fake Seerr behind a real SeerrService: settings and the movie and show
 * detail reads answer with fixtures, and the POST answers however the test says.
 * Any other request fails the test.
 */
function fakeSeerr(
  post: () => Response,
  detail: { movie?: RawMovieDetail; tv?: RawTvDetail } = {},
) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const { pathname } = new URL(String(input));
    if (init?.method === 'POST' && pathname === '/api/v1/request') return post();
    if (pathname === '/api/v1/settings/public') return json(200, settings);
    if (pathname === `/api/v1/movie/${movie.id}`) return json(200, detail.movie ?? movie);
    if (pathname === `/api/v1/tv/${tv.id}`) return json(200, detail.tv ?? tv);
    throw new Error(`Unrouted ${init?.method ?? 'GET'} ${pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  live = new seerrModule.SeerrService();
  return () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length;
}

/** The movie with two requests: #45 approved non-4K (January), #46 completed 4K (March). */
const movieWithRequests = (requests: RawMediaRequest[] = []): RawMovieDetail => ({
  ...movie,
  mediaInfo: {
    status: 5,
    requests: [
      { id: 45, status: 2, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 46, status: 5, is4k: true, createdAt: '2026-03-01T00:00:00.000Z' },
      ...requests,
    ],
  },
});

/** The movie carrying exactly these requests and nothing else. */
const movieWith = (requests: RawMediaRequest[]): RawMovieDetail => ({
  ...movie,
  mediaInfo: { status: 3, requests },
});

/** The show with an approved non-4K request (#70) — a row a TV 409 must not be pinned on. */
const tvWithRequests: RawTvDetail = {
  ...tv,
  mediaInfo: {
    status: 4,
    requests: [{ id: 70, status: 2, is4k: false, createdAt: '2026-02-01T00:00:00.000Z' }],
  },
};

const conflict = () => json(409, { message: 'Request for this media already exists.' });
const accepted = { action: 'accept', content: { confirmed: true } };

/** Run the handler through the production-shaped contract runner on a prepared context. */
const contract = (input: ReturnType<typeof requestMovieInput>, ctx: unknown) =>
  runToolContract(
    {
      ...requestMediaTool,
      handler: (args) =>
        requestMediaTool.handler(
          requestMediaTool.input.parse(args),
          ctx as Parameters<typeof requestMediaTool.handler>[1],
        ),
    },
    input,
  );

describe('seerr_request_media — how Seerr answers the POST', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.unstubAllGlobals();
    live = undefined;
  });

  it('maps a 409 to duplicate_request, naming the first same-quality request that blocks it', async () => {
    const posts = fakeSeerr(conflict, { movie: movieWithRequests() });
    const ctx = await roundTwo(accepted);

    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'duplicate_request', existingRequestId: 45 },
    });
    expect(posts()).toBe(1);
  });

  it('raises duplicate_request for a TV 409 even when the pre-POST read found no requests', async () => {
    fakeSeerr(conflict);
    const ctx = await roundTwo(accepted, requestTvInput());
    const error = await rejectionOf(() => requestMediaTool.handler(requestTvInput(), ctx));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'duplicate_request' },
    });
    expect(error.data).not.toHaveProperty('existingRequestId');
  });

  it('omits existingRequestId when the first same-quality request is declined or completed', async () => {
    fakeSeerr(conflict, {
      movie: movieWithRequests([
        { id: 47, status: 3, is4k: true, createdAt: '2026-04-01T00:00:00.000Z' },
      ]),
    });
    const input = requestMediaTool.input.parse({
      mediaType: 'movie',
      tmdbId: 1275779,
      mode: 'request',
      is4k: true,
    });
    const ctx = await roundTwo(accepted, input);
    const error = await rejectionOf(() => requestMediaTool.handler(input, ctx));

    expect(error.data).toMatchObject({ reason: 'duplicate_request' });
    expect(error.data).not.toHaveProperty('existingRequestId');
    expect(error.message).toBe(
      'Seerr refused the request: a 4K request for this title already exists.',
    );
  });

  it('carries duplicate_request, the blocking id, and its recovery on both result surfaces', async () => {
    fakeSeerr(conflict, { movie: movieWithRequests() });
    const ctx = await roundTwo(accepted);
    const result = await contract(requestMovieInput(), ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'duplicate_request',
          existingRequestId: 45,
          recovery: { hint: expect.stringContaining('existingRequestId') },
        },
      },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('#45');
    expect(text).toContain('seerr_request_status');
    // The recovery a content[]-only reader gets points at the #N in the message, not a field.
    expect(text).toContain('Recovery: Track the request numbered in the message');
    expect(JSON.stringify(result)).not.toContain('for this media');
  });

  it('chains the service refusal as the cause of duplicate_request', async () => {
    fakeSeerr(conflict, { movie: movieWithRequests() });
    const ctx = await roundTwo(accepted);
    const error = await rejectionOf(() => requestMediaTool.handler(requestMovieInput(), ctx));

    expect(error.cause).toMatchObject({ data: { reason: 'duplicate_request' } });
  });

  /**
   * Seerr's check, mirrored: a movie 409 blocks on the title's first request at that
   * quality (lowest id) while it is pending, approved, or failed. Every other 409 —
   * every TV one — comes from the same-user auto-request rule, which names nothing here.
   */
  it('names no request for a TV 409, even beside an approved same-quality request', async () => {
    fakeSeerr(conflict, { tv: tvWithRequests });
    const ctx = await roundTwo(accepted, requestTvInput());
    const error = await rejectionOf(() => requestMediaTool.handler(requestTvInput(), ctx));

    expect(error.data).toMatchObject({ reason: 'duplicate_request' });
    expect(error.data).not.toHaveProperty('existingRequestId');
    expect(error.message).toBe(
      'Seerr refused the request: a non-4K request for this title already exists.',
    );
  });

  it('carries a TV duplicate_request without an id, and its recovery, on both result surfaces', async () => {
    fakeSeerr(conflict, { tv: tvWithRequests });
    const ctx = await roundTwo(accepted, requestTvInput());
    const result = await contract(requestTvInput(), ctx);

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as { error: { data: Record<string, unknown> } };
    expect(error.data).toMatchObject({ reason: 'duplicate_request' });
    expect(error.data).not.toHaveProperty('existingRequestId');
    const text = JSON.stringify(result.content);
    expect(text).toContain('a non-4K request for this title already exists');
    expect(text).toContain('seerr_get_media');
    expect(text).not.toContain('#70');
  });

  it('names the lowest-id same-quality movie request, whatever its array position or createdAt', async () => {
    fakeSeerr(conflict, {
      movie: movieWith([
        { id: 53, status: 2, is4k: false, createdAt: '2026-03-01T00:00:00.000Z' },
        { id: 51, status: 1, is4k: false, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 55, status: 4, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' },
      ]),
    });
    const ctx = await roundTwo(accepted);
    const error = await rejectionOf(() => requestMediaTool.handler(requestMovieInput(), ctx));

    expect(error.data).toMatchObject({ reason: 'duplicate_request', existingRequestId: 51 });
  });

  it('names none when the first same-quality movie request is declined, beside a newer approved one', async () => {
    fakeSeerr(conflict, {
      movie: movieWith([
        { id: 61, status: 2, is4k: false, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 60, status: 3, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' },
      ]),
    });
    const ctx = await roundTwo(accepted);
    const error = await rejectionOf(() => requestMediaTool.handler(requestMovieInput(), ctx));

    expect(error.data).toMatchObject({ reason: 'duplicate_request' });
    expect(error.data).not.toHaveProperty('existingRequestId');
  });

  it.each([
    { quality: 'non-4K', is4k: false, other: { id: 80, status: 2, is4k: true } },
    { quality: '4K', is4k: true, other: { id: 81, status: 2, is4k: false } },
  ])(
    'names no request for a $quality 409 beside an active request at the other quality',
    async ({ is4k, other }) => {
      fakeSeerr(conflict, { movie: movieWith([other]) });
      const ctx = await roundTwo(accepted, requestMovieInput(is4k));
      const error = await rejectionOf(() => requestMediaTool.handler(requestMovieInput(is4k), ctx));

      expect(error.data).toMatchObject({ reason: 'duplicate_request' });
      expect(error.data).not.toHaveProperty('existingRequestId');
    },
  );

  it.each([
    {
      is4k: false,
      row: { id: 45, status: 2, is4k: false },
      message: 'Seerr refused the request: non-4K request #45 for this title already exists.',
    },
    {
      is4k: true,
      row: { id: 50, status: 1, is4k: true },
      message: 'Seerr refused the request: 4K request #50 for this title already exists.',
    },
  ])('words a 409 that names #$row.id at is4k=$is4k exactly', async ({ is4k, row, message }) => {
    fakeSeerr(conflict, { movie: movieWith([row]) });
    const ctx = await roundTwo(accepted, requestMovieInput(is4k));
    const error = await rejectionOf(() => requestMediaTool.handler(requestMovieInput(is4k), ctx));

    expect(error.message).toBe(message);
  });

  it('keeps any other refused POST status generic', async () => {
    fakeSeerr(() => json(403, { message: 'Movie Quota exceeded.' }), {
      movie: movieWithRequests(),
    });
    const ctx = await roundTwo(accepted);
    const error = await rejectionOf(() => requestMediaTool.handler(requestMovieInput(), ctx));

    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data).not.toHaveProperty('reason');
  });

  it('refuses a 202 as no_seasons_available and builds no created block', async () => {
    const posts = fakeSeerr(() => json(202, { message: 'No seasons available to request' }));
    const ctx = await roundTwo(accepted, requestTvInput());

    await expect(requestMediaTool.handler(requestTvInput(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'no_seasons_available' },
    });
    expect(posts()).toBe(1);
  });

  it('carries no_seasons_available and its recovery on both result surfaces', async () => {
    fakeSeerr(() => json(202, { message: 'No seasons available to request' }));
    const ctx = await roundTwo(accepted, requestTvInput());
    const result = await contract(requestTvInput(), ctx);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'no_seasons_available',
          recovery: { hint: expect.stringContaining('seerr_get_media') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Recovery: Nothing was created');
    expect(JSON.stringify(result.content)).toContain('episode count');
  });

  it('declares no_seasons_available in the error contract with an actionable recovery', () => {
    expect(requestMediaTool.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'no_seasons_available',
          code: JsonRpcErrorCode.InvalidParams,
          recovery: expect.stringContaining('Nothing was created'),
        }),
      ]),
    );
  });

  it('returns created for a 201 answered through the service', async () => {
    fakeSeerr(() => json(201, { id: 601, status: 2, media: { status: 3 } }), {
      movie: movieWithRequests(),
    });
    const ctx = await roundTwo(accepted);
    const result = await requestMediaTool.handler(requestMovieInput(), ctx);

    expect(result.created).toEqual({
      requestId: 601,
      requestStatus: { raw: 2, label: 'approved' },
      mediaStatus: { raw: 3, label: 'processing' },
    });
    expect(result.existingRequest).toMatchObject({ requestId: 46 });
  });

  it('never reports created for a 2xx answer without a numeric id', async () => {
    fakeSeerr(() => json(201, { status: 1 }));
    const ctx = await roundTwo(accepted);

    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
  });
});

describe('seerr_request_media — existing request in preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getPublicSettings.mockResolvedValue(settings);
  });

  it('surfaces the existing request in preview output', async () => {
    service.getMovie.mockResolvedValue({
      ...movie,
      mediaInfo: {
        requests: [{ id: 45, status: 2, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' }],
      },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({ mediaType: 'movie', tmdbId: 1275779 });
    const result = await requestMediaTool.handler(input, ctx);
    expect(result.existingRequest).toMatchObject({ requestId: 45, is4k: false });
  });

  it('surfaces the latest request of a show in preview output', async () => {
    service.getTv.mockResolvedValueOnce(tvWithRequests);
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({ mediaType: 'tv', tmdbId: 1399, seasons: [1] });
    const result = await requestMediaTool.handler(input, ctx);

    expect(result.existingRequest).toEqual({
      requestId: 70,
      status: { raw: 2, label: 'approved' },
      is4k: false,
    });
    const text = (requestMediaTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Latest request:** #70 — status approved (2) | 4K: No');
  });
});

describe('seerr_request_media — format', () => {
  it('keeps a title holding a line break in one heading', () => {
    const blocks = requestMediaTool.format!({
      mode: 'preview',
      resolved: { tmdbId: 1275779, mediaType: 'movie', title: 'Line\nBreak', year: 2026 },
      capability: { is4kEnabled: true, partialRequestsEnabled: true },
      payload: { mediaType: 'movie', mediaId: 1275779, is4k: false },
    });
    expect(readHeadings((blocks[0] as { text: string }).text)).toEqual([
      'Preview: Line\nBreak (2026) — movie',
    ]);
  });

  it('renders preview vs created and every payload field', () => {
    const previewBlocks = requestMediaTool.format!({
      mode: 'preview',
      resolved: { tmdbId: 1275779, mediaType: 'movie', title: 'Disclosure Day', year: 2026 },
      capability: { is4kEnabled: true, partialRequestsEnabled: true },
      payload: { mediaType: 'movie', mediaId: 1275779, is4k: false },
    });
    const previewText = (previewBlocks[0] as { text: string }).text;
    expect(previewText).toContain('No request was created');
    expect(previewText).toContain('1275779');

    const createdBlocks = requestMediaTool.format!({
      mode: 'request',
      resolved: { tmdbId: 1275779, mediaType: 'movie', title: 'Disclosure Day' },
      capability: { is4kEnabled: true, partialRequestsEnabled: true },
      payload: { mediaType: 'movie', mediaId: 1275779, is4k: false },
      created: { requestId: 501, requestStatus: { raw: 1, label: 'pending' } },
    });
    expect((createdBlocks[0] as { text: string }).text).toContain('Created request #501');
  });

  it('labels existingRequest as the latest request, whatever its state', () => {
    const blocks = requestMediaTool.format!({
      mode: 'preview',
      resolved: { tmdbId: 1275779, mediaType: 'movie', title: 'Disclosure Day' },
      capability: { is4kEnabled: true, partialRequestsEnabled: true },
      payload: { mediaType: 'movie', mediaId: 1275779, is4k: false },
      existingRequest: { requestId: 46, status: { raw: 5, label: 'completed' }, is4k: true },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('\n**Latest request:** #46 — status completed (5) | 4K: Yes');
    expect(text).not.toContain('Existing request');
  });
});
