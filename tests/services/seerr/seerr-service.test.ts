/**
 * @fileoverview Tests for SeerrService, mocking global `fetch`. The service checks
 * `response.ok` and routes non-OK responses through the not-found classifier — so a
 * mocked non-OK Response MUST drive the throwing error path (it does, via the
 * service's `request()` pipeline). Covers: 500 "Unable to retrieve movie." →
 * media_not_found (NotFound), 404 "Request not found." → request_not_found
 * (NotFound), the X-Api-Key header, and the settings cache.
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
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe('TEST-API-KEY');
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

  it('parses and returns a successful movie detail payload', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: 1275779, title: 'Disclosure Day', runtime: 145 }),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    const movie = await getSeerrService().getMovie(1275779, ctx);
    expect(movie).toMatchObject({ id: 1275779, title: 'Disclosure Day' });
  });

  it('caches /settings/public — a second call does not re-fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { movie4kEnabled: true, mediaServerType: 2 }));
    const ctx = createMockContext({ tenantId: 'test' });

    const first = await getSeerrService().getPublicSettings(ctx);
    const second = await getSeerrService().getPublicSettings(ctx);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
