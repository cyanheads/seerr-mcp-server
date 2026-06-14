/**
 * @fileoverview seerr_get_media — confirm the exact title before a write. Wraps
 * `GET /movie/{id}` or `GET /tv/{id}`, optionally `GET /tv/{id}/season/{n}` for an
 * episode list. Returns availability + whether a request already exists (derived
 * from `mediaInfo.requests[]`, most-recent first). A missing TMDB id surfaces as a
 * clean `media_not_found` (Seerr's raw HTTP 500 is classified in the service layer).
 * @module mcp-server/tools/definitions/get-media.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  redactAvailability,
  redactEpisode,
  redactOpenRequest,
  redactSeason,
} from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';
import { StatusRef, statusText } from '@/services/seerr/status.js';

/** Parse a 4-digit year from an ISO-ish date string. */
function yearOf(date: string | undefined): number | undefined {
  if (!date) return;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

export const getMediaTool = tool('seerr_get_media', {
  title: 'seerr-mcp-server: get media',
  description:
    "Fetch exact movie or show details by TMDB ID and media type to confirm the right title before any write. Returns availability and any existing open request. For TV, omit seasonNumber for a per-season summary, or pass a seasonNumber to fetch that season's episode list. Get the tmdbId from seerr_search_media first.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    mediaType: z
      .enum(['movie', 'tv'])
      .describe(
        'Whether tmdbId refers to a movie or TV show. Determines which detail endpoint is queried.',
      ),
    tmdbId: z
      .number()
      .int()
      .positive()
      .describe('TMDB ID from seerr_search_media (the results[].tmdbId field).'),
    seasonNumber: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "TV only: fetch this season's episode list. Season 0 is Specials. Omit for a show-level summary with per-season counts.",
      ),
  }),
  output: z.object({
    tmdbId: z.number().describe('TMDB ID for chaining to seerr_request_media.'),
    mediaType: z.enum(['movie', 'tv']).describe('Movie or TV.'),
    title: z.string().describe('Title (movie) or name (TV).'),
    year: z.number().optional().describe('Release/first-air year; omitted when unknown.'),
    overview: z.string().optional().describe('Synopsis.'),
    runtimeMinutes: z.number().optional().describe('Movie runtime in minutes (movies only).'),
    productionStatus: z
      .string()
      .optional()
      .describe('TMDB production status, e.g. "Released", "Returning Series".'),
    availability: z
      .object({
        tracked: z.boolean().describe('True when Seerr tracks this title.'),
        status: StatusRef.describe('Decoded availability {raw,label}.'),
        status4k: StatusRef.optional().describe('Decoded 4K availability when 4K is enabled.'),
        openRequest: z
          .object({
            requestId: z.number().describe('Existing request ID — pass to seerr_request_status.'),
            status: StatusRef.describe('Decoded request status {raw,label}.'),
            is4k: z.boolean().describe('Whether the open request is for 4K.'),
          })
          .optional()
          .describe(
            'Most recent existing request for this title, if any — avoids duplicate requests.',
          ),
      })
      .describe('Seerr availability + existing-request context for this title.'),
    seasons: z
      .array(
        z
          .object({
            seasonNumber: z.number().describe('Season number; 0 = Specials.'),
            name: z.string().describe('Season name.'),
            episodeCount: z.number().describe('Episode count in this season.'),
            airDate: z
              .string()
              .nullable()
              .describe('Season air date (ISO) or null when unannounced.'),
          })
          .describe('A per-season summary entry.'),
      )
      .optional()
      .describe('TV only: per-season summary (omitted for movies).'),
    episodes: z
      .array(
        z
          .object({
            episodeNumber: z.number().describe('Episode number within the season.'),
            name: z.string().describe('Episode title.'),
            airDate: z.string().nullable().describe('Air date (ISO) or null.'),
            overview: z.string().optional().describe('Episode synopsis.'),
          })
          .describe('An episode entry within the requested season.'),
      )
      .optional()
      .describe('TV only: episode list, present only when seasonNumber was provided.'),
  }),
  errors: [
    {
      reason: 'media_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The TMDB ID does not resolve to a movie/show (Seerr returns HTTP 500 "Unable to retrieve movie.").',
      recovery:
        'Call seerr_search_media to find the correct tmdbId, then retry with the exact ID and matching mediaType.',
    },
  ],

  async handler(input, ctx) {
    const seerr = getSeerrService();

    if (input.mediaType === 'movie') {
      const movie = await seerr.getMovie(input.tmdbId, ctx);
      const media = movie.mediaInfo;
      const openRequest = redactOpenRequest(media);
      const availability = {
        tracked: media !== undefined,
        ...redactAvailability(media ?? {}),
        ...(openRequest ? { openRequest } : {}),
      };
      ctx.log.info('Seerr movie detail fetched', {
        tmdbId: input.tmdbId,
        tracked: media !== undefined,
      });
      return {
        tmdbId: movie.id,
        mediaType: 'movie' as const,
        title: movie.title ?? '',
        ...(yearOf(movie.releaseDate) !== undefined ? { year: yearOf(movie.releaseDate) } : {}),
        ...(movie.overview?.trim() ? { overview: movie.overview.trim() } : {}),
        ...(typeof movie.runtime === 'number' ? { runtimeMinutes: movie.runtime } : {}),
        ...(movie.status ? { productionStatus: movie.status } : {}),
        availability,
      };
    }

    // TV
    const tv = await seerr.getTv(input.tmdbId, ctx);
    const media = tv.mediaInfo;
    const openRequest = redactOpenRequest(media);
    const availability = {
      tracked: media !== undefined,
      ...redactAvailability(media ?? {}),
      ...(openRequest ? { openRequest } : {}),
    };

    let episodes: ReturnType<typeof redactEpisode>[] | undefined;
    if (typeof input.seasonNumber === 'number') {
      const season = await seerr.getSeason(input.tmdbId, input.seasonNumber, ctx);
      episodes = (season.episodes ?? []).map(redactEpisode);
    }

    ctx.log.info('Seerr TV detail fetched', {
      tmdbId: input.tmdbId,
      tracked: media !== undefined,
      season: input.seasonNumber,
    });
    return {
      tmdbId: tv.id,
      mediaType: 'tv' as const,
      title: tv.name ?? '',
      ...(yearOf(tv.firstAirDate) !== undefined ? { year: yearOf(tv.firstAirDate) } : {}),
      ...(tv.overview?.trim() ? { overview: tv.overview.trim() } : {}),
      ...(tv.status ? { productionStatus: tv.status } : {}),
      availability,
      seasons: (tv.seasons ?? []).map(redactSeason),
      ...(episodes ? { episodes } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const yearPart = result.year !== undefined ? ` (${result.year})` : '';
    lines.push(`# ${result.title}${yearPart} — ${result.mediaType}`);
    const facts = [`**TMDB ID:** ${result.tmdbId}`];
    if (result.runtimeMinutes !== undefined)
      facts.push(`**Runtime:** ${result.runtimeMinutes} min`);
    if (result.productionStatus) facts.push(`**Status:** ${result.productionStatus}`);
    lines.push(facts.join(' | '));

    const a = result.availability;
    const fourK = a.status4k ? ` | 4K: ${statusText(a.status4k)}` : '';
    lines.push(
      `**Tracked by Seerr:** ${a.tracked ? 'Yes' : 'No'} | **Availability:** ${statusText(a.status)}${fourK}`,
    );
    if (a.openRequest) {
      lines.push(
        `**Open request:** #${a.openRequest.requestId} — status ${statusText(a.openRequest.status)} | 4K=${a.openRequest.is4k} — track with seerr_request_status.`,
      );
    }
    if (result.overview) {
      lines.push('');
      lines.push(result.overview);
    }
    if (result.seasons && result.seasons.length > 0) {
      lines.push('');
      lines.push('## Seasons');
      for (const s of result.seasons) {
        lines.push(
          `- **S${s.seasonNumber} ${s.name}** — ${s.episodeCount} episodes${s.airDate ? ` (aired ${s.airDate})` : ''}`,
        );
      }
    }
    if (result.episodes && result.episodes.length > 0) {
      lines.push('');
      lines.push('## Episodes');
      for (const e of result.episodes) {
        lines.push(`- **E${e.episodeNumber} ${e.name}**${e.airDate ? ` (${e.airDate})` : ''}`);
        if (e.overview) lines.push(`  ${e.overview}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
