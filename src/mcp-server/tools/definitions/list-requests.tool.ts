/**
 * @fileoverview seerr_list_requests — review recent requests and their lifecycle.
 * Wraps `GET /request`. Echoes the applied filters and decodes every numeric
 * status. The media-type discriminator is the raw `type` field (not `mediaType`);
 * `requestedBy` is PII-redacted; `title` is left unpopulated by default (the
 * request object has no title field — resolving it would cost one media fetch per
 * row). The total count comes from `pageInfo.results`.
 * @module mcp-server/tools/definitions/list-requests.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { normalizeSeasons, redactUser } from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';
import {
  decodeMediaStatus,
  decodeRequestStatus,
  StatusRef,
  statusText,
} from '@/services/seerr/status.js';

export const listRequestsTool = tool('seerr_list_requests', {
  title: 'seerr-mcp-server: list requests',
  description:
    'List recent media requests with their lifecycle status. Filter by status, media type, and requester; echoes the applied filters and decodes every numeric status. Pass a requestId from the results to seerr_request_status for full detail. Titles are not on request objects, so they are omitted here — fetch a title with seerr_get_media when needed.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    filter: z
      .enum([
        'all',
        'approved',
        'available',
        'pending',
        'processing',
        'unavailable',
        'failed',
        'deleted',
        'completed',
      ])
      .default('all')
      .describe(
        'Lifecycle filter. "pending" = awaiting approval; "processing" = downloading; "available" = ready to watch; "failed" = needs retry in Seerr.',
      ),
    mediaType: z
      .enum(['movie', 'tv', 'all'])
      .default('all')
      .describe('Restrict to movies, TV, or both.'),
    requestedById: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Seerr numeric user ID to show only one requester's requests. Omit for all requesters.",
      ),
    sort: z
      .enum(['added', 'modified'])
      .default('added')
      .describe('Sort key: when the request was created ("added") or last changed ("modified").'),
    sortDirection: z
      .enum(['asc', 'desc'])
      .default('desc')
      .describe('Sort direction. Default desc shows the most recent first.'),
    take: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Page size — max requests to return in one call.'),
    skip: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Number of requests to skip for pagination (offset). Use take+skip to page.'),
  }),
  output: z.object({
    requests: z
      .array(
        z
          .object({
            requestId: z.number().describe('Request ID — pass to seerr_request_status.'),
            mediaType: z.enum(['movie', 'tv']).describe('Movie or TV.'),
            title: z
              .string()
              .optional()
              .describe(
                'Title of the requested media; absent because request objects carry no title field.',
              ),
            tmdbId: z.number().optional().describe('TMDB ID of the requested media.'),
            requestStatus: StatusRef.describe('Decoded request status {raw,label}.'),
            mediaStatus: StatusRef.optional().describe(
              'Decoded availability of the underlying media {raw,label} (from media.status).',
            ),
            is4k: z.boolean().describe('Whether this is a 4K request.'),
            seasons: z
              .array(z.number())
              .optional()
              .describe(
                'Requested season numbers (TV); empty array or omitted for movies or full-series requests.',
              ),
            requestedBy: z
              .object({
                id: z.number().describe('Requester user ID.'),
                displayName: z.string().describe('Requester display name (no email/tokens).'),
              })
              .describe('Who requested it — id + display name only.'),
            createdAt: z.string().describe('ISO timestamp the request was created.'),
          })
          .describe('A single media request and its decoded lifecycle state.'),
      )
      .describe('Matching requests, most-recent first by default.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total requests matching the filter, before pagination.'),
    appliedFilters: z
      .object({
        filter: z.string().describe('The lifecycle filter applied.'),
        mediaType: z.string().describe('The media-type filter applied.'),
        sort: z.string().describe('The sort key applied.'),
      })
      .describe('The filter set the server applied to the request list.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the page filled to the take limit (more may exist).'),
    shown: z.number().optional().describe('Number of requests returned.'),
    cap: z.number().optional().describe('The take limit that was applied.'),
    notice: z.string().optional().describe('Guidance when no requests matched.'),
  },
  enrichmentTrailer: {
    appliedFilters: {
      render: (f: { filter: string; mediaType: string; sort: string }) =>
        `**Filters:** status=${f.filter}, media=${f.mediaType}, sort=${f.sort}`,
    },
  },

  async handler(input, ctx) {
    const seerr = getSeerrService();
    const response = await seerr.listRequests(
      {
        filter: input.filter,
        mediaType: input.mediaType,
        sort: input.sort,
        sortDirection: input.sortDirection,
        take: input.take,
        skip: input.skip,
        ...(typeof input.requestedById === 'number' ? { requestedById: input.requestedById } : {}),
      },
      ctx,
    );

    const rows = response.results ?? [];
    const requests = rows.map((r) => {
      const mediaType = r.type === 'tv' ? ('tv' as const) : ('movie' as const);
      const seasons = normalizeSeasons(r);
      const tmdbId = r.media?.tmdbId;
      const mediaStatus =
        typeof r.media?.status === 'number' ? decodeMediaStatus(r.media.status) : undefined;
      return {
        requestId: r.id,
        mediaType,
        ...(typeof tmdbId === 'number' ? { tmdbId } : {}),
        requestStatus: decodeRequestStatus(r.status ?? 1),
        ...(mediaStatus ? { mediaStatus } : {}),
        is4k: r.is4k === true,
        ...(seasons.length > 0 ? { seasons } : {}),
        requestedBy: r.requestedBy ? redactUser(r.requestedBy) : { id: 0, displayName: 'Unknown' },
        createdAt: r.createdAt ?? '',
      };
    });

    const total = response.pageInfo?.results ?? requests.length;
    ctx.enrich.total(total);
    ctx.enrich({
      appliedFilters: { filter: input.filter, mediaType: input.mediaType, sort: input.sort },
    });
    if (requests.length >= input.take && requests.length < total) {
      ctx.enrich.truncated({ shown: requests.length, cap: input.take });
    }
    if (requests.length === 0) {
      ctx.enrich.notice(
        `No requests matched filter="${input.filter}", mediaType="${input.mediaType}". Try filter="all" or a different mediaType.`,
      );
    }

    ctx.log.info('Seerr request list fetched', {
      filter: input.filter,
      returned: requests.length,
      total,
    });
    return { requests };
  },

  format: (result) => {
    if (result.requests.length === 0) {
      return [{ type: 'text', text: 'No requests matched the filter.' }];
    }
    const lines: string[] = [];
    for (const r of result.requests) {
      lines.push(
        `## Request #${r.requestId} — ${r.title ?? 'Untitled'} (${r.mediaType}, 4K=${r.is4k})`,
      );
      const facts = [
        `**TMDB ID:** ${r.tmdbId ?? 'n/a'}`,
        `**Status:** ${statusText(r.requestStatus)}`,
      ];
      if (r.mediaStatus) facts.push(`**Media:** ${statusText(r.mediaStatus)}`);
      facts.push(`**Requested by:** ${r.requestedBy.displayName} (id ${r.requestedBy.id})`);
      if (r.createdAt) facts.push(`**Created:** ${r.createdAt}`);
      lines.push(facts.join(' | '));
      if (r.seasons && r.seasons.length > 0) lines.push(`**Seasons:** ${r.seasons.join(', ')}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
