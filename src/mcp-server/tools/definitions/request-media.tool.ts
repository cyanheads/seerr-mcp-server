/**
 * @fileoverview seerr_request_media — the guarded write, the only mutation in the
 * surface. It resolves and PREVIEWS a request payload by default (mode: preview,
 * no write), and creates the request only on mode:request AND an explicit
 * ctx.elicit confirmation. "Download X" means "create a Seerr request for X" —
 * never a direct Radarr/Sonarr call.
 *
 * Three-layer guard:
 *   1. mode:preview is the blast-radius-safe default (resolve + validate, no POST).
 *   2. mode:request triggers a ctx.elicit confirmation when the client supports it.
 *   3. destructiveHint:true is the fallback signal for non-interactive clients.
 *
 * Capability validation (4K enabled? seasons valid? partial allowed?) runs LOCALLY
 * against the cached /settings/public BEFORE any POST, so a bad request fails with
 * an actionable typed error rather than a failed write.
 * @module mcp-server/tools/definitions/request-media.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { redactOpenRequest } from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';
import {
  decodeMediaStatus,
  decodeRequestStatus,
  StatusRef,
  statusText,
} from '@/services/seerr/status.js';
import type { CreateRequestBody, RawMediaInfo } from '@/services/seerr/types.js';

export const requestMediaTool = tool('seerr_request_media', {
  title: 'seerr-mcp-server: request media',
  description:
    'Create a Seerr media request — the guarded write. Defaults to mode:preview, which resolves the exact title and returns the request payload that WOULD be submitted WITHOUT creating anything; pass mode:request to actually submit (a confirmation is requested first when the client supports it). Treat "download X" as "create a Seerr request for X". Always preview first unless the title is already confirmed.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    mediaType: z.enum(['movie', 'tv']).describe('Whether tmdbId is a movie or TV show.'),
    tmdbId: z
      .number()
      .int()
      .positive()
      .describe(
        'TMDB ID from seerr_search_media (results[].tmdbId). Must be the exact resolved ID — preview shows the title it resolves to before submitting.',
      ),
    mode: z
      .enum(['preview', 'request'])
      .default('preview')
      .describe(
        '"preview" (default) resolves and returns the exact payload that WOULD be submitted WITHOUT creating anything. "request" submits the request to Seerr. Always preview first unless the title is already confirmed.',
      ),
    is4k: z
      .boolean()
      .default(false)
      .describe(
        'Request the 4K version. Only valid when the instance has 4K enabled for this media type (preview reports capability); Seerr rejects 4K requests otherwise.',
      ),
    seasons: z
      .union([
        z.literal('all'),
        z
          .array(z.number().int().min(0))
          .min(1)
          .describe(
            'Explicit list of season numbers to request, e.g. [1, 2]. Season 0 is Specials — accepted only when the instance enables special episodes.',
          ),
      ])
      .optional()
      .describe(
        'TV only. "all" hands the whole series to the instance, which decides whether that includes season 0 (Specials). An explicit list (e.g. [1,2]) requests exactly those seasons, and season 0 is rejected unless the instance enables special episodes. Required for TV requests; ignored for movies.',
      ),
    serverId: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Override the Radarr/Sonarr server ID (from seerr_service_options). Omit to use the Seerr default — recommended.',
      ),
    profileId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Override the quality profile ID (from seerr_service_options). Omit to use the server default.',
      ),
    rootFolder: z
      .string()
      .optional()
      .describe(
        'Override the root folder path. Omit to use the server default — recommended. Rarely needed; Seerr routes by default.',
      ),
    languageProfileId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Sonarr language profile ID override (TV only). Omit to use the default. No-op on Sonarr v4.',
      ),
  }),
  output: z.object({
    mode: z.enum(['preview', 'request']).describe('Which arm ran.'),
    resolved: z
      .object({
        tmdbId: z.number().describe('Resolved TMDB ID.'),
        mediaType: z.enum(['movie', 'tv']).describe('Movie or TV.'),
        title: z
          .string()
          .describe('Resolved title — confirm this matches intent before requesting.'),
        year: z.number().optional().describe('Release/first-air year.'),
      })
      .describe('What the tmdbId resolved to — the confirmation surface.'),
    capability: z
      .object({
        is4kEnabled: z
          .boolean()
          .describe('Whether 4K is enabled for this media type on the instance.'),
        partialRequestsEnabled: z.boolean().describe('Whether per-season TV requests are allowed.'),
      })
      .describe('Instance constraints relevant to this request.'),
    payload: z
      .object({
        mediaType: z.enum(['movie', 'tv']).describe('Payload media type.'),
        mediaId: z.number().describe('TMDB ID Seerr will request.'),
        is4k: z.boolean().describe('4K flag in the payload.'),
        seasons: z
          .union([
            z.literal('all'),
            z.array(z.number()).describe('Explicit season numbers in the payload.'),
          ])
          .optional()
          .describe('Seasons in the payload (TV).'),
        serverId: z.number().optional().describe('Server override, if any.'),
        profileId: z.number().optional().describe('Profile override, if any.'),
        rootFolder: z.string().optional().describe('Root folder override, if any.'),
        languageProfileId: z.number().optional().describe('Language profile override, if any.'),
      })
      .describe('The exact request body that was (or would be) submitted.'),
    existingRequest: z
      .object({
        requestId: z
          .number()
          .describe('Existing request ID for this title, if one already exists.'),
        status: StatusRef.describe('Decoded status of the existing request.'),
        is4k: z.boolean().describe('Whether the existing request is 4K.'),
      })
      .optional()
      .describe(
        'Surfaced when the title already has a request — preview warns; request still proceeds if the agent intends a distinct (e.g. 4K) request.',
      ),
    created: z
      .object({
        requestId: z.number().describe('New request ID — pass to seerr_request_status.'),
        requestStatus: StatusRef.describe(
          'Decoded status of the created request (often "pending" or auto-"approved").',
        ),
        mediaStatus: StatusRef.optional().describe('Decoded media availability after creation.'),
      })
      .optional()
      .describe('Present only when mode=request and the POST succeeded.'),
  }),
  errors: [
    {
      reason: 'media_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'tmdbId does not resolve to a movie/show (Seerr 500 "Unable to retrieve movie.").',
      recovery:
        'Run seerr_search_media to get the correct tmdbId and retry with the matching mediaType.',
    },
    {
      reason: 'seasons_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'mediaType is tv but no seasons were provided.',
      recovery: 'Provide seasons: "all" for the whole series or an explicit list like [1,2].',
    },
    {
      reason: 'four_k_not_enabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'is4k:true but the instance has no 4K configured for this media type.',
      recovery:
        'Resubmit with is4k:false, or check seerr_service_options for 4K availability first.',
    },
    {
      reason: 'partial_requests_disabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'an explicit season list was given but the instance disallows partial requests.',
      recovery: 'Use seasons:"all" to request the full series instead of specific seasons.',
    },
    {
      reason: 'special_episodes_not_enabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'the season list includes 0 (Specials) but the instance has special episodes disabled.',
      recovery:
        'Drop season 0 from the list, or confirm specialEpisodesEnabled via seerr_service_options first.',
    },
    {
      reason: 'duplicate_request',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Seerr rejects the POST because an identical request already exists.',
      recovery:
        'Check the existingRequest in this output; track it with seerr_request_status instead of re-requesting.',
    },
    {
      reason: 'request_cancelled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'the user declined the elicit confirmation.',
      recovery:
        'Re-run with mode:request and confirm the prompt if you intend to submit the request.',
    },
  ],

  async handler(input, ctx) {
    const seerr = getSeerrService();

    // Step 1 — capability flags (cached). Step 2 — resolve title + existing requests.
    const settings = await seerr.getPublicSettings(ctx);
    const is4kEnabled =
      input.mediaType === 'movie'
        ? settings.movie4kEnabled === true
        : settings.series4kEnabled === true;
    const partialRequestsEnabled = settings.partialRequestsEnabled === true;

    let title = '';
    let year: number | undefined;
    let media: RawMediaInfo | undefined;
    if (input.mediaType === 'movie') {
      const movie = await seerr.getMovie(input.tmdbId, ctx);
      title = movie.title ?? '';
      year = yearOf(movie.releaseDate);
      media = movie.mediaInfo;
    } else {
      const tv = await seerr.getTv(input.tmdbId, ctx);
      title = tv.name ?? '';
      year = yearOf(tv.firstAirDate);
      media = tv.mediaInfo;
    }
    const existingRequest = redactOpenRequest(media);

    // Step 3 — local validation BEFORE any write (actionable typed errors, no failed POST).
    if (input.mediaType === 'tv' && input.seasons === undefined) {
      throw ctx.fail('seasons_required', undefined, { ...ctx.recoveryFor('seasons_required') });
    }
    if (input.is4k && !is4kEnabled) {
      throw ctx.fail(
        'four_k_not_enabled',
        `4K is not enabled for ${input.mediaType} requests on this instance.`,
        {
          ...ctx.recoveryFor('four_k_not_enabled'),
        },
      );
    }
    /**
     * Season constraints apply to the TV arm only — `buildPayload` drops `seasons`
     * for a movie, so a movie request carrying one is a no-op, not a violation.
     */
    const seasonList =
      input.mediaType === 'tv' && Array.isArray(input.seasons) ? input.seasons : undefined;
    if (seasonList && !partialRequestsEnabled) {
      throw ctx.fail('partial_requests_disabled', undefined, {
        ...ctx.recoveryFor('partial_requests_disabled'),
      });
    }
    if (seasonList?.includes(0) && settings.enableSpecialEpisodes !== true) {
      throw ctx.fail(
        'special_episodes_not_enabled',
        'Season 0 (Specials) cannot be requested — special episodes are disabled on this instance.',
        { ...ctx.recoveryFor('special_episodes_not_enabled') },
      );
    }

    const resolved = {
      tmdbId: input.tmdbId,
      mediaType: input.mediaType,
      title,
      ...(year !== undefined ? { year } : {}),
    };
    const capability = { is4kEnabled, partialRequestsEnabled };
    const payload = buildPayload(input);
    const baseOutput = {
      resolved,
      capability,
      payload,
      ...(existingRequest ? { existingRequest } : {}),
    };

    // PREVIEW — resolve + validate only, no write.
    if (input.mode === 'preview') {
      ctx.log.info('Seerr request previewed', { tmdbId: input.tmdbId, mediaType: input.mediaType });
      return { mode: 'preview' as const, ...baseOutput };
    }

    // REQUEST — guarded write. Layer 2: elicit confirmation when the client supports it.
    if (ctx.elicit) {
      const seasonSummary =
        input.mediaType === 'tv'
          ? input.seasons === 'all'
            ? ' (all seasons)'
            : Array.isArray(input.seasons)
              ? ` (seasons ${input.seasons.join(', ')})`
              : ''
          : '';
      const confirm = await ctx.elicit(
        `Create a Seerr request for "${title}"${input.is4k ? ' (4K)' : ''}${seasonSummary}? This adds it to your Radarr/Sonarr download queue.`,
        z.object({ confirmed: z.literal(true).describe('Set true to submit the request.') }),
      );
      if (confirm.action !== 'accept') {
        throw ctx.fail('request_cancelled', 'Request cancelled before submission.', {
          ...ctx.recoveryFor('request_cancelled'),
        });
      }
    }

    // Layer 1+3: preview default already passed; destructiveHint covers non-elicit clients.
    let created: {
      requestId: number;
      requestStatus: ReturnType<typeof decodeRequestStatus>;
      mediaStatus?: ReturnType<typeof decodeMediaStatus>;
    };
    try {
      const result = await seerr.createRequest(payload, ctx);
      const mediaStatus =
        typeof result.media?.status === 'number'
          ? decodeMediaStatus(result.media.status)
          : undefined;
      created = {
        requestId: result.id,
        requestStatus: decodeRequestStatus(result.status ?? 1),
        ...(mediaStatus ? { mediaStatus } : {}),
      };
    } catch (err) {
      // Cross-check a rejected POST against the resolved existing request → duplicate.
      if (existingRequest && isDuplicateRejection(err)) {
        throw ctx.fail(
          'duplicate_request',
          'Seerr rejected the request as a duplicate of an existing one.',
          {
            existingRequestId: existingRequest.requestId,
            ...ctx.recoveryFor('duplicate_request'),
          },
        );
      }
      throw err;
    }

    ctx.log.notice('Seerr request created', {
      tmdbId: input.tmdbId,
      requestId: created.requestId,
      status: created.requestStatus.label,
    });
    return { mode: 'request' as const, ...baseOutput, created };
  },

  format: (result) => {
    const lines: string[] = [];
    const r = result.resolved;
    const yearPart = r.year !== undefined ? ` (${r.year})` : '';
    const verb = result.mode === 'preview' ? 'Preview' : 'Request submitted';
    lines.push(`# ${verb}: ${r.title}${yearPart} — ${r.mediaType}`);
    lines.push(`**TMDB ID:** ${r.tmdbId}`);
    lines.push(
      `**Capability:** 4K ${result.capability.is4kEnabled ? 'enabled' : 'disabled'} | partial requests ${result.capability.partialRequestsEnabled ? 'enabled' : 'disabled'}`,
    );

    const p = result.payload;
    const payloadFacts = [`media=${p.mediaType}`, `tmdbId=${p.mediaId}`, `4K=${p.is4k}`];
    if (p.seasons !== undefined)
      payloadFacts.push(`seasons=${p.seasons === 'all' ? 'all' : p.seasons.join(',')}`);
    if (p.serverId !== undefined) payloadFacts.push(`serverId=${p.serverId}`);
    if (p.profileId !== undefined) payloadFacts.push(`profileId=${p.profileId}`);
    if (p.rootFolder !== undefined) payloadFacts.push(`rootFolder=${p.rootFolder}`);
    if (p.languageProfileId !== undefined)
      payloadFacts.push(`languageProfileId=${p.languageProfileId}`);
    lines.push(`**Payload:** ${payloadFacts.join(', ')}`);

    if (result.existingRequest) {
      lines.push(
        `**Existing request:** #${result.existingRequest.requestId} — status ${statusText(result.existingRequest.status)} | 4K: ${result.existingRequest.is4k ? 'Yes' : 'No'} — a request for this title already exists.`,
      );
    }
    if (result.mode === 'preview') {
      lines.push('');
      lines.push('> No request was created. Re-run with mode:request to submit.');
    }
    if (result.created) {
      lines.push('');
      const ms = result.created.mediaStatus
        ? ` | media ${statusText(result.created.mediaStatus)}`
        : '';
      lines.push(
        `**Created request #${result.created.requestId}** — status ${statusText(result.created.requestStatus)}${ms}. Track with seerr_request_status.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Parse a 4-digit year from an ISO-ish date string. */
function yearOf(date: string | undefined): number | undefined {
  if (!date) return;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

/** Build the `POST /request` body from validated input. `userId` is intentionally never set. */
function buildPayload(input: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  is4k: boolean;
  seasons?: number[] | 'all' | undefined;
  serverId?: number | undefined;
  profileId?: number | undefined;
  rootFolder?: string | undefined;
  languageProfileId?: number | undefined;
}): CreateRequestBody {
  return {
    mediaType: input.mediaType,
    mediaId: input.tmdbId,
    is4k: input.is4k,
    ...(input.mediaType === 'tv' && input.seasons !== undefined ? { seasons: input.seasons } : {}),
    ...(typeof input.serverId === 'number' ? { serverId: input.serverId } : {}),
    ...(typeof input.profileId === 'number' ? { profileId: input.profileId } : {}),
    ...(input.rootFolder ? { rootFolder: input.rootFolder } : {}),
    ...(typeof input.languageProfileId === 'number'
      ? { languageProfileId: input.languageProfileId }
      : {}),
  };
}

/** A Seerr POST rejection that signals an already-existing request (409, or a 500 with a duplicate message). */
function isDuplicateRejection(err: unknown): boolean {
  if (!(err instanceof McpError)) return false;
  const status = (err.data as { httpStatus?: number } | undefined)?.httpStatus;
  if (status === 409) return true;
  return /already exists|duplicate|existing request/i.test(err.message);
}
