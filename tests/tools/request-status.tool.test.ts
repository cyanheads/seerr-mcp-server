/**
 * @fileoverview Tests for seerr_request_status. Headline: track one request — decoded
 * request + media status, redacted requester, routing (no paths), and a state-tuned
 * hint. Covers: full projection, profileName-null routing, stateGuidance derivation,
 * modifiedBy redaction, unflagged title hydration (and its degrade modes), and the
 * request_not_found contract bubbling.
 * @module tests/tools/request-status.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = { getRequest: vi.fn(), getMovie: vi.fn(), getTv: vi.fn() };

vi.mock('@/services/seerr/seerr-service.js', () => ({ getSeerrService: () => service }));

const { requestStatusTool } = await import('@/mcp-server/tools/definitions/request-status.tool.js');

describe('seerr_request_status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a fully decoded, redacted request detail (requestedBy AND modifiedBy stripped)', async () => {
    service.getRequest.mockResolvedValue({
      id: 45,
      type: 'movie',
      status: 1,
      is4k: false,
      seasons: [],
      serverId: 0,
      // profileName absent at the single-request endpoint
      createdAt: '2026-06-08T10:50:48.000Z',
      updatedAt: '2026-06-08T10:50:48.000Z',
      requestedBy: { id: 1, username: 'mediauser', email: 'leak@example.com' },
      modifiedBy: { id: 1, username: 'mediauser', plexToken: 'SECRET-TOKEN' },
      media: { tmdbId: 1275779, status: 1 },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 45 }),
      ctx,
    );

    expect(result).toMatchObject({
      requestId: 45,
      mediaType: 'movie',
      tmdbId: 1275779,
      requestStatus: { raw: 1, label: 'pending' },
      is4k: false,
      requestedBy: { id: 1, displayName: 'mediauser' },
      routing: { serverId: 0, is4k: false },
    });
    expect(result.routing.profileName).toBeUndefined();
    // A pending request yields a state hint.
    expect(result.stateGuidance).toContain('approval');
    const json = JSON.stringify(result);
    expect(json).not.toContain('leak@example.com');
    expect(json).not.toContain('SECRET-TOKEN');
  });

  it('derives a downloading hint for an approved request whose media is processing', async () => {
    service.getRequest.mockResolvedValue({
      id: 50,
      type: 'movie',
      status: 2,
      media: { tmdbId: 1, status: 3 },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 50 }),
      ctx,
    );
    expect(result.stateGuidance).toContain('downloading');
  });

  it('derives the hint from status4k on a 4K request whose non-4K status is unknown', async () => {
    service.getRequest.mockResolvedValue({
      id: 47,
      type: 'movie',
      status: 2,
      is4k: true,
      media: { tmdbId: 1275779, status: 1, status4k: 3 },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 47 }),
      ctx,
    );
    expect(result.mediaStatus).toEqual({ raw: 1, label: 'unknown' });
    expect(result.mediaStatus4k).toEqual({ raw: 3, label: 'processing' });
    expect(result.stateGuidance).toContain('downloading');
  });

  it('decodes a failed request (status 4) and guides the user to retry in the Seerr UI', async () => {
    service.getRequest.mockResolvedValue({
      id: 51,
      type: 'movie',
      status: 4,
      media: { status: 1 },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 51 }),
      ctx,
    );
    expect(result.requestStatus).toEqual({ raw: 4, label: 'failed' });
    expect(result.stateGuidance).toContain('Seerr UI');
  });

  it('decodes a completed request (status 5) — the common state on a working instance', async () => {
    service.getRequest.mockResolvedValue({
      id: 37,
      type: 'movie',
      status: 5,
      media: { status: 5 },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 37 }),
      ctx,
    );
    expect(result.requestStatus).toEqual({ raw: 5, label: 'completed' });
    expect(result.mediaStatus).toEqual({ raw: 5, label: 'available' });
    expect(result.stateGuidance).toContain('available');
  });

  /* --- title hydration (no flag — a single request costs one extra read) --- */

  it('joins the title from the media record without any opt-in flag', async () => {
    service.getRequest.mockResolvedValue({
      id: 47,
      type: 'movie',
      status: 2,
      media: { tmdbId: 299534, status: 3 },
    });
    service.getMovie.mockResolvedValue({ id: 299534, title: 'Avengers: Endgame' });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 47 }),
      ctx,
    );

    expect(service.getMovie).toHaveBeenCalledWith(299534, ctx, { maxRetries: 0 });
    expect(result.title).toBe('Avengers: Endgame');
    const text = (requestStatusTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Request #47 — Avengers: Endgame');
  });

  it('reads the TV title from `name` on a tv request', async () => {
    service.getRequest.mockResolvedValue({
      id: 49,
      type: 'tv',
      status: 2,
      seasons: [{ seasonNumber: 1 }],
      media: { tmdbId: 1399, status: 4 },
    });
    service.getTv.mockResolvedValue({ id: 1399, name: 'Game of Thrones' });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 49 }),
      ctx,
    );
    expect(result.title).toBe('Game of Thrones');
  });

  it('degrades to no title when the media lookup fails, keeping every other field', async () => {
    service.getRequest.mockResolvedValue({
      id: 53,
      type: 'movie',
      status: 2,
      media: { tmdbId: 404404, status: 3 },
    });
    service.getMovie.mockRejectedValue(new Error('Unable to retrieve movie.'));
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 53 }),
      ctx,
    );

    expect(result.title).toBeUndefined();
    expect(result).toMatchObject({ requestId: 53, tmdbId: 404404, mediaStatus: { raw: 3 } });
    const text = (requestStatusTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Request #53 — Untitled');
  });

  it('skips the lookup entirely when the request carries no tmdbId', async () => {
    service.getRequest.mockResolvedValue({ id: 54, type: 'movie', status: 2, media: {} });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 54 }),
      ctx,
    );

    expect(service.getMovie).not.toHaveBeenCalled();
    expect(result.title).toBeUndefined();
    expect(result.requestId).toBe(54);
  });

  /** The sparser arm of the same case: Seerr can omit `media` from the request entirely. */
  it('skips the lookup when the request carries no media object at all', async () => {
    service.getRequest.mockResolvedValue({ id: 55, type: 'movie', status: 2 });
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    const result = await requestStatusTool.handler(
      requestStatusTool.input.parse({ requestId: 55 }),
      ctx,
    );

    expect(service.getMovie).not.toHaveBeenCalled();
    expect(result.title).toBeUndefined();
    expect(result).toMatchObject({ requestId: 55, requestStatus: { label: 'approved' } });
  });

  it('bubbles request_not_found for a missing request id', async () => {
    service.getRequest.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Request not found.', {
        reason: 'request_not_found',
      }),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: requestStatusTool.errors });
    await expect(
      requestStatusTool.handler(requestStatusTool.input.parse({ requestId: 999999 }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'request_not_found' },
    });
  });
});
