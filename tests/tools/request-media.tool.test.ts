/**
 * @fileoverview Tests for seerr_request_media — the guarded 2-step write. Mocks
 * SeerrService so the handler logic (preview vs request, elicit confirmation, local
 * capability validation, duplicate detection, redaction) is exercised deterministically.
 * The headline guarantees verified literally: preview NEVER writes; a real write
 * happens ONLY after an accepted elicit (or, for non-elicit clients, the
 * destructiveHint-guarded path); a declined elicit cancels with no write.
 * @module tests/tools/request-media.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = {
  movie4kEnabled: true,
  series4kEnabled: true,
  partialRequestsEnabled: true,
  enableSpecialEpisodes: false,
};

const service = {
  getPublicSettings: vi.fn(async () => settings),
  getMovie: vi.fn(async () => ({
    id: 1275779,
    title: 'Disclosure Day',
    releaseDate: '2026-06-10',
    mediaInfo: undefined,
  })),
  getTv: vi.fn(async () => ({
    id: 1399,
    name: 'Game of Thrones',
    firstAirDate: '2011-04-17',
    mediaInfo: undefined,
  })),
  createRequest: vi.fn(async () => ({ id: 501, status: 1, media: { status: 2 } })),
};

vi.mock('@/services/seerr/seerr-service.js', () => ({
  getSeerrService: () => service,
}));

const { requestMediaTool } = await import('@/mcp-server/tools/definitions/request-media.tool.js');

describe('seerr_request_media — preview (default, no write)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getPublicSettings.mockResolvedValue(settings);
    service.getMovie.mockResolvedValue({
      id: 1275779,
      title: 'Disclosure Day',
      releaseDate: '2026-06-10',
      mediaInfo: undefined,
    });
    service.createRequest.mockResolvedValue({ id: 501, status: 1, media: { status: 2 } });
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
    service.getMovie.mockResolvedValue({
      id: 1275779,
      title: 'Disclosure Day',
      releaseDate: '2026-06-10',
      mediaInfo: undefined,
    });
    service.createRequest.mockResolvedValue({ id: 501, status: 1, media: { status: 2 } });
  });

  it('writes ONLY after an accepted elicit confirmation', async () => {
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } });
    const ctx = createMockContext({ tenantId: 'test', elicit, errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'movie',
      tmdbId: 1275779,
      mode: 'request',
    });
    const result = await requestMediaTool.handler(input, ctx);

    expect(elicit).toHaveBeenCalledOnce();
    expect(service.createRequest).toHaveBeenCalledOnce();
    expect(result.created).toMatchObject({
      requestId: 501,
      requestStatus: { raw: 1, label: 'pending' },
    });
  });

  it('does NOT write when the elicit confirmation is declined (request_cancelled)', async () => {
    const elicit = vi.fn().mockResolvedValue({ action: 'decline' });
    const ctx = createMockContext({ tenantId: 'test', elicit, errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'movie',
      tmdbId: 1275779,
      mode: 'request',
    });

    await expect(requestMediaTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'request_cancelled' },
    });
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it('writes via the destructiveHint-guarded path when the client has no elicit', async () => {
    // No elicit on ctx — non-interactive client; destructiveHint is the guard signal.
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'movie',
      tmdbId: 1275779,
      mode: 'request',
    });
    const result = await requestMediaTool.handler(input, ctx);

    expect(service.createRequest).toHaveBeenCalledOnce();
    expect(result.created?.requestId).toBe(501);
  });

  it('carries the destructiveHint annotation (the non-interactive guard signal)', () => {
    expect(requestMediaTool.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});

describe('seerr_request_media — local validation before any write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getPublicSettings.mockResolvedValue(settings);
    service.getTv.mockResolvedValue({
      id: 1399,
      name: 'Game of Thrones',
      firstAirDate: '2011-04-17',
      mediaInfo: undefined,
    });
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
    service.getMovie.mockResolvedValue({ id: 1, title: 'X', mediaInfo: undefined });
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
      id: 1275779,
      title: 'Disclosure Day',
      mediaInfo: {
        requests: [{ id: 45, status: 2, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' }],
      },
    });
    service.createRequest.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Request already exists', { httpStatus: 409 }),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: requestMediaTool.errors });
    const input = requestMediaTool.input.parse({
      mediaType: 'movie',
      tmdbId: 1275779,
      mode: 'request',
    });
    await expect(requestMediaTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'duplicate_request' },
    });
  });

  it('surfaces the existing request in preview output', async () => {
    service.getMovie.mockResolvedValue({
      id: 1275779,
      title: 'Disclosure Day',
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
