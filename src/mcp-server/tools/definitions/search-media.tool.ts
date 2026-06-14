/**
 * @fileoverview seerr_search_media — title disambiguation entry point. Wraps
 * `GET /search`, filters to movie/TV (drops `person`), normalizes each hit, and
 * decodes `mediaInfo` availability when Seerr already tracks the title. The
 * required first step before any request. Search-result `mediaInfo` carries only
 * `status`/`status4k` (no open-request data — that lives on the detail endpoints).
 * @module mcp-server/tools/definitions/search-media.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { redactAvailability } from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';
import { StatusRef, statusText } from '@/services/seerr/status.js';
import type { RawSearchResult } from '@/services/seerr/types.js';

/** Parse a 4-digit year from an ISO-ish date string; returns undefined when unparseable. */
function yearOf(date: string | undefined): number | undefined {
  if (!date) return;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

export const searchMediaTool = tool('seerr_search_media', {
  title: 'seerr-mcp-server: search media',
  description:
    'Search movies and TV shows by title and return ranked matches with TMDB ID, year, overview, and decoded availability status when Seerr already tracks the title. People are always excluded. This is the required first step before requesting media — use the returned tmdbId with seerr_get_media or seerr_request_media.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Title to search for, e.g. "Mulan" or "Severance". Natural-language titles are fine; Seerr matches against TMDB.',
      ),
    mediaType: z
      .enum(['movie', 'tv', 'all'])
      .default('all')
      .describe(
        'Restrict results to movies, TV shows, or both. People are always excluded — this server requests media, not actors.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(1)
      .describe(
        '1-based result page. Seerr returns ~20 results per page; use with a prior call to page through.',
      ),
    language: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional()
      .describe(
        'ISO 639-1 language for titles/overviews, e.g. "en" or "pt-BR". Defaults to the Seerr instance locale when omitted.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe(
        'Max normalized results to return from this page (caps output size; does not change which page is fetched).',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            tmdbId: z
              .number()
              .describe('TMDB ID — pass to seerr_get_media or seerr_request_media as tmdbId.'),
            mediaType: z.enum(['movie', 'tv']).describe('Whether this is a movie or TV show.'),
            title: z.string().describe('Display title (movie title or show name).'),
            year: z
              .number()
              .optional()
              .describe(
                'Release year (movies) or first-air year (TV); omitted when the date is unknown.',
              ),
            overview: z.string().optional().describe('Short synopsis; omitted when TMDB has none.'),
            voteAverage: z
              .number()
              .optional()
              .describe('TMDB vote average (0–10) for relevance/quality signal.'),
            tracked: z
              .boolean()
              .describe(
                'True when Seerr already tracks this title (mediaInfo present) — availability data follows.',
              ),
            availability: z
              .object({
                status: StatusRef.describe('Decoded media availability {raw,label}.'),
                status4k: StatusRef.optional().describe(
                  'Decoded 4K availability {raw,label} when the instance has 4K enabled.',
                ),
              })
              .optional()
              .describe('Current Seerr availability; present only when tracked is true.'),
          })
          .describe('A single ranked movie/TV match.'),
      )
      .describe('Ranked movie/TV matches. Empty array when nothing matched.'),
  }),
  enrichment: {
    effectiveQuery: z.string().describe('The query as the server parsed it.'),
    totalCount: z
      .number()
      .describe('Total results Seerr reported for the query before this page limit.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when this page yielded more results than the limit returned.'),
    shown: z.number().optional().describe('Number of results returned after the limit.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Guidance when nothing matched.'),
  },

  async handler(input, ctx) {
    const seerr = getSeerrService();
    const response = await seerr.search(
      {
        query: input.query,
        page: input.page,
        ...(input.language ? { language: input.language } : {}),
      },
      ctx,
    );

    const wanted = (
      input.mediaType === 'all' ? ['movie', 'tv'] : [input.mediaType]
    ) as ReadonlyArray<string>;

    const matches = (response.results ?? [])
      .filter(
        (r): r is RawSearchResult & { mediaType: 'movie' | 'tv' } =>
          r.mediaType === 'movie' || r.mediaType === 'tv',
      )
      .filter((r) => wanted.includes(r.mediaType));

    const limited = matches.slice(0, input.limit);
    const results = limited.map((r) => {
      const isMovie = r.mediaType === 'movie';
      const tracked = r.mediaInfo !== undefined;
      return {
        tmdbId: r.id,
        mediaType: r.mediaType,
        title: (isMovie ? r.title : r.name) ?? '',
        ...(yearOf(isMovie ? r.releaseDate : r.firstAirDate) !== undefined
          ? { year: yearOf(isMovie ? r.releaseDate : r.firstAirDate) }
          : {}),
        ...(r.overview?.trim() ? { overview: r.overview.trim() } : {}),
        ...(typeof r.voteAverage === 'number' ? { voteAverage: r.voteAverage } : {}),
        tracked,
        ...(tracked && r.mediaInfo ? { availability: redactAvailability(r.mediaInfo) } : {}),
      };
    });

    ctx.enrich.echo(input.query);
    ctx.enrich.total(response.totalResults ?? matches.length);
    if (matches.length > input.limit) {
      ctx.enrich.truncated({ shown: results.length, cap: input.limit });
    }
    if (results.length === 0) {
      ctx.enrich.notice(
        `No movie/TV match for "${input.query}". Try a different spelling or broaden mediaType to "all".`,
      );
    }

    ctx.log.info('Seerr search completed', {
      query: input.query,
      matched: matches.length,
      returned: results.length,
    });
    return { results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matching movies or TV shows.' }];
    }
    const lines: string[] = [];
    for (const r of result.results) {
      const yearPart = r.year !== undefined ? ` (${r.year})` : '';
      lines.push(`## ${r.title}${yearPart} — ${r.mediaType}`);
      const facts = [`**TMDB ID:** ${r.tmdbId}`];
      if (r.voteAverage !== undefined) facts.push(`**Rating:** ${r.voteAverage.toFixed(1)}/10`);
      facts.push(`**Tracked by Seerr:** ${r.tracked ? 'Yes' : 'No'}`);
      lines.push(facts.join(' | '));
      if (r.availability) {
        const fourK = r.availability.status4k
          ? ` | 4K: ${statusText(r.availability.status4k)}`
          : '';
        lines.push(`**Availability:** ${statusText(r.availability.status)}${fourK}`);
      }
      if (r.overview) lines.push(r.overview);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
