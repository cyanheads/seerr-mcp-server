/**
 * @fileoverview Tests for the seerr://request/{requestId} resource. It mirrors
 * seerr_request_status via the same projectRequestDetail choke point and title
 * join, so the tests confirm it returns a redacted detail, hydrates the title
 * with no flag to gate on, and bubbles request_not_found. The URI param is a
 * numeric string (validated by the params schema).
 * @module tests/resources/request.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = { getRequest: vi.fn(), getMovie: vi.fn(), getTv: vi.fn() };

vi.mock('@/services/seerr/seerr-service.js', () => ({ getSeerrService: () => service }));

const { seerrRequestResource } = await import(
  '@/mcp-server/resources/definitions/request.resource.js'
);

describe('seerr://request/{requestId} resource', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a redacted request detail for a numeric requestId', async () => {
    service.getRequest.mockResolvedValue({
      id: 45,
      type: 'movie',
      status: 2,
      serverId: 0,
      createdAt: '2026-06-08T10:50:48.000Z',
      updatedAt: '2026-06-08T10:50:48.000Z',
      requestedBy: { id: 1, username: 'mediauser', email: 'leak@example.com' },
      media: { tmdbId: 1275779, status: 5 },
    });
    const ctx = createMockContext({
      tenantId: 'test',
      errors: seerrRequestResource.errors,
      uri: new URL('seerr://request/45'),
    });
    const params = seerrRequestResource.params.parse({ requestId: '45' });
    const result = await seerrRequestResource.handler(params, ctx);

    expect(result).toMatchObject({
      requestId: 45,
      mediaType: 'movie',
      requestStatus: { raw: 2, label: 'approved' },
      requestedBy: { id: 1, displayName: 'mediauser' },
    });
    expect(service.getRequest).toHaveBeenCalledWith(45, ctx);
    expect(JSON.stringify(result)).not.toContain('leak@example.com');
  });

  it('derives 4K guidance from status4k, matching seerr_request_status', async () => {
    service.getRequest.mockResolvedValue({
      id: 47,
      type: 'movie',
      status: 2,
      is4k: true,
      createdAt: '2026-06-08T10:50:48.000Z',
      updatedAt: '2026-06-08T10:50:48.000Z',
      requestedBy: { id: 1, username: 'mediauser' },
      media: { tmdbId: 1275779, status: 1, status4k: 3 },
    });
    const ctx = createMockContext({
      tenantId: 'test',
      errors: seerrRequestResource.errors,
      uri: new URL('seerr://request/47'),
    });
    const params = seerrRequestResource.params.parse({ requestId: '47' });
    const result = await seerrRequestResource.handler(params, ctx);

    expect(result).toMatchObject({
      is4k: true,
      mediaStatus: { raw: 1, label: 'unknown' },
      mediaStatus4k: { raw: 3, label: 'processing' },
    });
    expect(result.stateGuidance).toContain('downloading');
  });

  it('joins the title on every read — a resource has no flag to gate on', async () => {
    service.getRequest.mockResolvedValue({
      id: 47,
      type: 'movie',
      status: 2,
      createdAt: '2026-06-08T10:50:48.000Z',
      updatedAt: '2026-06-08T10:50:48.000Z',
      requestedBy: { id: 1, username: 'mediauser' },
      media: { tmdbId: 299534, status: 3 },
    });
    service.getMovie.mockResolvedValue({ id: 299534, title: 'Avengers: Endgame' });
    const ctx = createMockContext({
      tenantId: 'test',
      errors: seerrRequestResource.errors,
      uri: new URL('seerr://request/47'),
    });
    const params = seerrRequestResource.params.parse({ requestId: '47' });
    const result = await seerrRequestResource.handler(params, ctx);

    expect(service.getMovie).toHaveBeenCalledWith(299534, ctx, { maxRetries: 0 });
    expect(result.title).toBe('Avengers: Endgame');
  });

  it('skips the lookup when the request carries no tmdbId', async () => {
    service.getRequest.mockResolvedValue({
      id: 51,
      type: 'movie',
      status: 2,
      createdAt: '2026-06-08T10:50:48.000Z',
      updatedAt: '2026-06-08T10:50:48.000Z',
      requestedBy: { id: 1, username: 'mediauser' },
      media: {},
    });
    const ctx = createMockContext({
      tenantId: 'test',
      errors: seerrRequestResource.errors,
      uri: new URL('seerr://request/51'),
    });
    const params = seerrRequestResource.params.parse({ requestId: '51' });
    const result = await seerrRequestResource.handler(params, ctx);

    expect(service.getMovie).not.toHaveBeenCalled();
    expect(result.title).toBeUndefined();
    expect(result).toMatchObject({ requestId: 51, requestStatus: { label: 'approved' } });
  });

  it('omits the title when the media lookup fails, keeping the rest of the detail', async () => {
    service.getRequest.mockResolvedValue({
      id: 53,
      type: 'movie',
      status: 2,
      createdAt: '2026-06-08T10:50:48.000Z',
      updatedAt: '2026-06-08T10:50:48.000Z',
      requestedBy: { id: 1, username: 'mediauser' },
      media: { tmdbId: 404404, status: 3 },
    });
    service.getMovie.mockRejectedValue(new Error('Unable to retrieve movie.'));
    const ctx = createMockContext({
      tenantId: 'test',
      errors: seerrRequestResource.errors,
      uri: new URL('seerr://request/53'),
    });
    const params = seerrRequestResource.params.parse({ requestId: '53' });
    const result = await seerrRequestResource.handler(params, ctx);

    expect(result.title).toBeUndefined();
    expect(result).toMatchObject({ requestId: 53, tmdbId: 404404, mediaStatus: { raw: 3 } });
  });

  it('rejects a non-numeric requestId at the params schema', () => {
    expect(() => seerrRequestResource.params.parse({ requestId: 'abc' })).toThrow();
  });

  it('bubbles request_not_found for a missing request', async () => {
    service.getRequest.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Request not found.', {
        reason: 'request_not_found',
      }),
    );
    const ctx = createMockContext({
      tenantId: 'test',
      errors: seerrRequestResource.errors,
      uri: new URL('seerr://request/999999'),
    });
    const params = seerrRequestResource.params.parse({ requestId: '999999' });
    await expect(seerrRequestResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'request_not_found' },
    });
  });
});
