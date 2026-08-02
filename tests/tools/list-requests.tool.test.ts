/**
 * @fileoverview Tests for seerr_list_requests. Headline: list recent requests with
 * decoded statuses and a PII-redacted requester. Covers: type→mediaType mapping,
 * media.tmdbId/status projection, requester redaction, totalCount from
 * pageInfo.results, the empty-result notice, and format rendering.
 * @module tests/tools/list-requests.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = { listRequests: vi.fn() };

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
