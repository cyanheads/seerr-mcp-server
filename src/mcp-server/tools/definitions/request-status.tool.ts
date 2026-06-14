/**
 * @fileoverview seerr_request_status — track one request through its lifecycle.
 * Wraps `GET /request/{id}`. Returns decoded request + media status, requester
 * (PII-redacted), a routing summary (names/IDs only — no filesystem paths), and a
 * status-tuned recovery hint. A missing request id surfaces as request_not_found
 * (Seerr's raw HTTP 404 is classified in the service layer). `profileName` is null
 * at this endpoint, so routing.profileName is optional; `title` is not on the
 * request object, so it is left unpopulated.
 * @module mcp-server/tools/definitions/request-status.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { projectRequestDetail } from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';
import { StatusRef, statusText } from '@/services/seerr/status.js';

export const requestStatusTool = tool('seerr_request_status', {
  title: 'seerr-mcp-server: request status',
  description:
    'Fetch one media request by ID and return its decoded request status, decoded media availability (including 4K), requester, a routing summary, and a next-step hint tuned to the current state. Get the requestId from seerr_request_media (created.requestId) or seerr_list_requests.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    requestId: z
      .number()
      .int()
      .positive()
      .describe(
        'Request ID from seerr_request_media (created.requestId) or seerr_list_requests (requests[].requestId).',
      ),
  }),
  output: z.object({
    requestId: z.number().describe('The request ID.'),
    mediaType: z.enum(['movie', 'tv']).describe('Movie or TV.'),
    title: z.string().optional().describe('Title of the requested media when joinable.'),
    tmdbId: z.number().optional().describe('TMDB ID of the media.'),
    requestStatus: StatusRef.describe('Decoded request status {raw,label}.'),
    mediaStatus: StatusRef.optional().describe('Decoded media availability {raw,label}.'),
    mediaStatus4k: StatusRef.optional().describe(
      'Decoded 4K availability {raw,label} when applicable.',
    ),
    is4k: z.boolean().describe('Whether this is a 4K request.'),
    seasons: z.array(z.number()).optional().describe('Requested season numbers (TV).'),
    requestedBy: z
      .object({
        id: z.number().describe('Requester user ID.'),
        displayName: z.string().describe('Requester display name (no email/tokens).'),
      })
      .describe('Who requested it — id + display name only.'),
    routing: z
      .object({
        serverId: z.number().optional().describe('Radarr/Sonarr server ID handling the request.'),
        profileName: z
          .string()
          .optional()
          .describe('Quality profile name; null when not set on this request.'),
        is4k: z.boolean().describe('Whether routed to the 4K service.'),
      })
      .describe('Routing summary — names/IDs only, no filesystem paths.'),
    createdAt: z.string().describe('ISO creation timestamp.'),
    updatedAt: z.string().describe('ISO last-updated timestamp.'),
    stateGuidance: z
      .string()
      .optional()
      .describe(
        'Recovery/next-step hint tuned to the current status, e.g. pending → "awaiting approval".',
      ),
  }),
  errors: [
    {
      reason: 'request_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No request exists with the given ID (Seerr returns HTTP 404 "Request not found.").',
      recovery: 'List requests with seerr_list_requests to find a valid requestId, then retry.',
    },
  ],

  async handler(input, ctx) {
    const seerr = getSeerrService();
    const raw = await seerr.getRequest(input.requestId, ctx);
    const detail = projectRequestDetail(raw);
    ctx.log.info('Seerr request status fetched', {
      requestId: input.requestId,
      status: detail.requestStatus.label,
    });
    return detail;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `# Request #${result.requestId} — ${result.title ?? 'Untitled'} (${result.mediaType}, 4K=${result.is4k})`,
    );
    lines.push(`**TMDB ID:** ${result.tmdbId ?? 'n/a'}`);

    const status = [`**Request:** ${statusText(result.requestStatus)}`];
    if (result.mediaStatus) status.push(`**Media:** ${statusText(result.mediaStatus)}`);
    if (result.mediaStatus4k) status.push(`**Media 4K:** ${statusText(result.mediaStatus4k)}`);
    lines.push(status.join(' | '));

    lines.push(`**Requested by:** ${result.requestedBy.displayName} (id ${result.requestedBy.id})`);
    const routing = [`**Routed 4K=${result.routing.is4k}**`];
    if (result.routing.serverId !== undefined)
      routing.push(`**Server ID:** ${result.routing.serverId}`);
    if (result.routing.profileName) routing.push(`**Profile:** ${result.routing.profileName}`);
    lines.push(routing.join(' | '));

    if (result.seasons && result.seasons.length > 0)
      lines.push(`**Seasons:** ${result.seasons.join(', ')}`);
    const timestamps: string[] = [];
    if (result.createdAt) timestamps.push(`**Created:** ${result.createdAt}`);
    if (result.updatedAt) timestamps.push(`**Updated:** ${result.updatedAt}`);
    if (timestamps.length > 0) lines.push(timestamps.join(' | '));
    if (result.stateGuidance) {
      lines.push('');
      lines.push(`> ${result.stateGuidance}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
