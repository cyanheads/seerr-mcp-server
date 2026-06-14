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
