/**
 * @fileoverview seerr://request/{requestId} — read-once request summary. Mirrors
 * seerr_request_status for clients that support injectable resource context:
 * decoded request + media status, requester (PII-redacted), routing summary, and a
 * state-tuned hint. Reuses the same `projectRequestDetail` choke point and title
 * join as the tool, so the output is identical and equally redacted. A resource
 * takes no per-read options, so the title is always joined — one request, one
 * extra read — and degrades to absent when the request has no tmdbId or the
 * lookup fails. No `list()` — request enumeration is the job of the filterable
 * seerr_list_requests tool (the tool-only access path).
 * @module mcp-server/resources/definitions/request.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { projectRequestDetail } from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';
import { StatusRef } from '@/services/seerr/status.js';
import { hydrateRequestTitle } from '@/services/seerr/titles.js';

export const seerrRequestResource = resource('seerr://request/{requestId}', {
  name: 'seerr-request',
  title: 'seerr-mcp-server: request',
  description:
    'Read-once summary of one Seerr media request by ID — decoded request status, media availability, requester, and routing. Mirrors seerr_request_status for clients that inject resources as context.',
  mimeType: 'application/json',
  params: z.object({
    requestId: z
      .string()
      .regex(/^\d+$/)
      .describe('Numeric Seerr request ID (from seerr_request_media or seerr_list_requests).'),
  }),
  output: z.object({
    requestId: z.number().describe('The request ID.'),
    mediaType: z.enum(['movie', 'tv']).describe('Movie or TV.'),
    title: z
      .string()
      .optional()
      .describe(
        'Title of the requested media, joined from the media record; absent when the request carries no tmdbId or the lookup failed.',
      ),
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
    stateGuidance: z.string().optional().describe('Next-step hint tuned to the current status.'),
  }),
  errors: [
    {
      reason: 'request_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No request exists with the given ID (Seerr returns HTTP 404 "Request not found.").',
      recovery: 'List requests with seerr_list_requests to find a valid requestId, then retry.',
    },
  ],

  async handler(params, ctx) {
    const seerr = getSeerrService();
    const raw = await seerr.getRequest(Number.parseInt(params.requestId, 10), ctx);
    const detail = await hydrateRequestTitle(projectRequestDetail(raw), seerr, ctx);
    ctx.log.debug('Seerr request resource read', {
      requestId: params.requestId,
      titleResolved: detail.title !== undefined,
    });
    return detail;
  },
});
