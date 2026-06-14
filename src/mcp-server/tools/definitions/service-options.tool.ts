/**
 * @fileoverview seerr_service_options — let an agent reason about request
 * capability and routing without a separate status tool. Summarizes configured
 * Radarr/Sonarr services + default quality profiles, folds in compact Seerr
 * version and public feature flags (4K, partial requests, specials). Filesystem
 * paths (root folders, `activeDirectory`/`activeAnimeDirectory`) are redacted
 * unless `includePaths: true`; `vapidPublic` and `plexClientIdentifier` from
 * `/settings/public` are never surfaced. Legs fan out with `Promise.allSettled`
 * so one failure degrades to a notice rather than failing the call.
 * @module mcp-server/tools/definitions/service-options.tool
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { redactProfile, redactRootFolder } from '@/services/seerr/normalizers.js';
import { getSeerrService, type SeerrService } from '@/services/seerr/seerr-service.js';
import { decodeMediaServer } from '@/services/seerr/status.js';
import type { RawServiceDetail, RawServiceListEntry } from '@/services/seerr/types.js';

type ServiceKind = 'radarr' | 'sonarr';

interface BuiltService {
  activeProfileId: number;
  is4k: boolean;
  isDefault: boolean;
  kind: ServiceKind;
  name: string;
  profiles?: { id: number; name: string }[];
  rootFolders?: { path: string; freeSpace?: number }[];
  serverId: number;
}

/**
 * Build one service summary: always fetches the detail endpoint for profile names;
 * includes root folders only when `includePaths`. A failed detail leg is recorded
 * as a warning and the profiles/folders are omitted (degraded, but honest).
 */
async function buildService(
  kind: ServiceKind,
  entry: RawServiceListEntry,
  includePaths: boolean,
  seerr: SeerrService,
  ctx: Context,
  warnings: string[],
): Promise<BuiltService> {
  const base: BuiltService = {
    kind,
    serverId: entry.id,
    name: entry.name ?? `${kind} ${entry.id}`,
    isDefault: entry.isDefault === true,
    is4k: entry.is4k === true,
    activeProfileId: entry.activeProfileId ?? 0,
  };

  let detail: RawServiceDetail | undefined;
  try {
    detail =
      kind === 'radarr'
        ? await seerr.getRadarrDetail(entry.id, ctx)
        : await seerr.getSonarrDetail(entry.id, ctx);
  } catch {
    warnings.push(
      `${kind === 'radarr' ? 'Radarr' : 'Sonarr'} details unavailable for server ${entry.id}; profile list omitted.`,
    );
    return base;
  }

  const profiles = (detail.profiles ?? []).map(redactProfile);
  const rootFolders = includePaths
    ? (detail.rootFolders ?? [])
        .map((f) => redactRootFolder(f, includePaths))
        .filter((f): f is { path: string; freeSpace?: number } => f !== undefined)
    : undefined;

  return {
    ...base,
    ...(profiles.length > 0 ? { profiles } : {}),
    ...(rootFolders ? { rootFolders } : {}),
  };
}

export const serviceOptionsTool = tool('seerr_service_options', {
  title: 'seerr-mcp-server: service options',
  description:
    'Summarize the configured Radarr (movie) and Sonarr (TV) services, their default quality profiles, and the Seerr instance capability flags (4K, partial requests, specials, media server) so an agent can reason about what kinds of requests will be accepted and how routing works. Filesystem paths are redacted unless includePaths is set.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    service: z
      .enum(['radarr', 'sonarr', 'all'])
      .default('all')
      .describe(
        'Which service(s) to summarize. "all" covers both movie (Radarr) and TV (Sonarr) routing.',
      ),
    includePaths: z
      .boolean()
      .default(false)
      .describe(
        'Include filesystem root-folder paths and free space. Default false redacts paths (operator-private). Set true only when you explicitly need routing paths.',
      ),
  }),
  output: z.object({
    instance: z
      .object({
        version: z.string().describe('Seerr version, e.g. "3.3.0".'),
        mediaServer: z.string().describe('Decoded media server: "plex" | "jellyfin" | "emby".'),
        movie4kEnabled: z.boolean().describe('Whether 4K movie requests are allowed.'),
        series4kEnabled: z.boolean().describe('Whether 4K TV requests are allowed.'),
        partialRequestsEnabled: z.boolean().describe('Whether per-season TV requests are allowed.'),
        specialEpisodesEnabled: z
          .boolean()
          .describe('Whether season 0 (Specials) can be requested.'),
      })
      .describe('Instance capability summary — what kinds of requests will be accepted.'),
    services: z
      .array(
        z
          .object({
            kind: z
              .enum(['radarr', 'sonarr'])
              .describe('Service type — Radarr (movies) or Sonarr (TV).'),
            serverId: z
              .number()
              .describe('Server ID — pass to seerr_request_media serverId to override routing.'),
            name: z.string().describe('Service display name.'),
            isDefault: z
              .boolean()
              .describe('Whether this is the default server for its media type.'),
            is4k: z.boolean().describe('Whether this server handles 4K.'),
            activeProfileId: z
              .number()
              .describe('Default quality profile ID — pass as profileId to override.'),
            profiles: z
              .array(
                z
                  .object({
                    id: z.number().describe('Quality profile ID for profileId overrides.'),
                    name: z.string().describe('Quality profile name, e.g. "HD-1080p", "Ultra-HD".'),
                  })
                  .describe('A configured quality profile.'),
              )
              .optional()
              .describe('Available quality profiles (from the detail endpoint).'),
            rootFolders: z
              .array(
                z
                  .object({
                    path: z
                      .string()
                      .describe('Root folder path — only present when includePaths is true.'),
                    freeSpace: z
                      .number()
                      .optional()
                      .describe(
                        'Free space in bytes (raw API field name: freeSpace) — only when includePaths is true.',
                      ),
                  })
                  .describe('A configured root folder.'),
              )
              .optional()
              .describe(
                'Root folders — omitted unless includePaths is true (paths are operator-private).',
              ),
          })
          .describe('A configured Radarr or Sonarr service with its routing defaults.'),
      )
      .describe('Configured Radarr/Sonarr services with routing defaults.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Disclosure when a service leg failed and its data was omitted.'),
  },

  async handler(input, ctx) {
    const seerr = getSeerrService();
    const wantRadarr = input.service === 'radarr' || input.service === 'all';
    const wantSonarr = input.service === 'sonarr' || input.service === 'all';
    const warnings: string[] = [];

    const [statusRes, settingsRes, radarrListRes, sonarrListRes] = await Promise.allSettled([
      seerr.getStatus(ctx),
      seerr.getPublicSettings(ctx),
      wantRadarr ? seerr.getRadarrServices(ctx) : Promise.resolve([] as RawServiceListEntry[]),
      wantSonarr ? seerr.getSonarrServices(ctx) : Promise.resolve([] as RawServiceListEntry[]),
    ]);

    const settings = settingsRes.status === 'fulfilled' ? settingsRes.value : {};
    if (settingsRes.status === 'rejected')
      warnings.push('Instance settings unavailable; capability flags may be incomplete.');
    if (statusRes.status === 'rejected') warnings.push('Seerr version unavailable.');

    const instance = {
      version:
        statusRes.status === 'fulfilled' ? (statusRes.value.version ?? 'unknown') : 'unknown',
      mediaServer: decodeMediaServer(settings.mediaServerType ?? 0),
      movie4kEnabled: settings.movie4kEnabled === true,
      series4kEnabled: settings.series4kEnabled === true,
      partialRequestsEnabled: settings.partialRequestsEnabled === true,
      specialEpisodesEnabled: settings.enableSpecialEpisodes === true,
    };

    const radarrList = radarrListRes.status === 'fulfilled' ? radarrListRes.value : [];
    if (wantRadarr && radarrListRes.status === 'rejected')
      warnings.push('Radarr service list unavailable.');
    const sonarrList = sonarrListRes.status === 'fulfilled' ? sonarrListRes.value : [];
    if (wantSonarr && sonarrListRes.status === 'rejected')
      warnings.push('Sonarr service list unavailable.');

    const services = await Promise.all([
      ...radarrList.map((entry) =>
        buildService('radarr', entry, input.includePaths, seerr, ctx, warnings),
      ),
      ...sonarrList.map((entry) =>
        buildService('sonarr', entry, input.includePaths, seerr, ctx, warnings),
      ),
    ]);

    if (warnings.length > 0) ctx.enrich.notice(warnings.join(' '));
    ctx.log.info('Seerr service options assembled', {
      service: input.service,
      serviceCount: services.length,
      warnings: warnings.length,
    });
    return { instance, services };
  },

  format: (result) => {
    const lines: string[] = [];
    const i = result.instance;
    lines.push(`# Seerr ${i.version} — ${i.mediaServer}`);
    lines.push(
      `**4K movies:** ${i.movie4kEnabled} | **4K series:** ${i.series4kEnabled} | **Partial requests:** ${i.partialRequestsEnabled} | **Specials:** ${i.specialEpisodesEnabled}`,
    );
    for (const s of result.services) {
      lines.push('');
      lines.push(`## ${s.name} — ${s.kind}${s.isDefault ? ' [default]' : ''}`);
      lines.push(
        `**Server ID:** ${s.serverId} | **4K:** ${s.is4k ? 'Yes' : 'No'} | **Default profile ID:** ${s.activeProfileId}`,
      );
      if (s.profiles && s.profiles.length > 0) {
        lines.push(`**Profiles:** ${s.profiles.map((p) => `${p.name} (#${p.id})`).join(', ')}`);
      }
      if (s.rootFolders && s.rootFolders.length > 0) {
        for (const f of s.rootFolders) {
          const free = f.freeSpace !== undefined ? ` — freeSpace ${f.freeSpace} bytes` : '';
          lines.push(`**Root folder:** ${f.path}${free}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
