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

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, expectInputRequired } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawMediaRequestDetail } from '@/services/seerr/seerr-service.js';
import type { RawMovieDetail, RawPublicSettings, RawTvDetail } from '@/services/seerr/types.js';

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

vi.mock('@/services/seerr/seerr-service.js', () => ({
  getSeerrService: () => service,
}));

const { requestMediaTool } = await import('@/mcp-server/tools/definitions/request-media.tool.js');

/** The `mode: request` arm, parsed through the tool's own input schema. */
const requestMovieInput = () =>
  requestMediaTool.input.parse({ mediaType: 'movie', tmdbId: 1275779, mode: 'request' });

/** Seeds the second round with whatever the client sent back for the confirmation key. */
const roundTwo = (response: unknown) =>
  createMockContext({
    tenantId: 'test',
    errors: requestMediaTool.errors,
    inputResponses: { confirm: response },
  });

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
    const ctx = roundTwo({ action: 'accept', content: { confirmed: true } });
    const result = await requestMediaTool.handler(requestMovieInput(), ctx);

    expect(service.createRequest).toHaveBeenCalledOnce();
    expect(result.created).toMatchObject({
      requestId: 501,
      requestStatus: { raw: 1, label: 'pending' },
      mediaStatus: { raw: 2, label: 'pending' },
    });
  });

  it('renders the created request through format() as well as structuredContent', async () => {
    const ctx = roundTwo({ action: 'accept', content: { confirmed: true } });
    const result = await requestMediaTool.handler(requestMovieInput(), ctx);

    // Claude Code reads structuredContent; Claude Desktop reads content[]. Both carry it.
    expect(result.created?.requestId).toBe(501);
    const text = (requestMediaTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Created request #501');
    expect(text).toContain('Request submitted: Disclosure Day');
    expect(text).toContain('seerr_request_status');
  });

  it('does NOT write when the confirmation is declined (request_cancelled)', async () => {
    const ctx = roundTwo({ action: 'decline' });
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
    const ctx = roundTwo({ action: 'cancel' });
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
    const ctx = roundTwo({ action: 'accept', content: { confirmed: 'yes please' } });
    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      data: { reason: 'request_cancelled' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('does NOT write on an accepted round that explicitly withholds consent', async () => {
    const ctx = roundTwo({ action: 'accept', content: { confirmed: false } });
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
});

describe('seerr_request_media — duplicate detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getPublicSettings.mockResolvedValue(settings);
  });

  it('maps a 409 POST rejection to duplicate_request when an existing request is present', async () => {
    service.getMovie.mockResolvedValue({
      ...movie,
      mediaInfo: {
        requests: [{ id: 45, status: 2, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' }],
      },
    });
    service.createRequest.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Request already exists', { httpStatus: 409 }),
    );
    const ctx = roundTwo({ action: 'accept', content: { confirmed: true } });
    await expect(requestMediaTool.handler(requestMovieInput(), ctx)).rejects.toMatchObject({
      data: { reason: 'duplicate_request', existingRequestId: 45 },
    });
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
});

describe('seerr_request_media — format', () => {
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
});
