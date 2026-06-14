/**
 * @fileoverview Tests for seerr_service_options. Headline: summarize Radarr/Sonarr
 * services + capability flags so an agent can reason about request routing. The key
 * security test: filesystem paths (root folders, activeDirectory) are redacted by
 * default and surfaced only when includePaths:true. Also covers capability decoding,
 * profile-name resolution from the detail endpoint, and graceful degradation.
 * @module tests/tools/service-options.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = {
  getStatus: vi.fn(),
  getPublicSettings: vi.fn(),
  getRadarrServices: vi.fn(),
  getSonarrServices: vi.fn(),
  getRadarrDetail: vi.fn(),
  getSonarrDetail: vi.fn(),
};

vi.mock('@/services/seerr/seerr-service.js', () => ({ getSeerrService: () => service }));

const { serviceOptionsTool } = await import(
  '@/mcp-server/tools/definitions/service-options.tool.js'
);

function primeHappyPath() {
  service.getStatus.mockResolvedValue({ version: '3.3.0' });
  service.getPublicSettings.mockResolvedValue({
    movie4kEnabled: true,
    series4kEnabled: true,
    partialRequestsEnabled: true,
    enableSpecialEpisodes: false,
    mediaServerType: 2,
    vapidPublic: 'VAPID-PUBLIC-KEY-SECRET',
    plexClientIdentifier: 'plex-uuid-secret',
  });
  service.getRadarrServices.mockResolvedValue([
    {
      id: 0,
      name: 'Radarr',
      is4k: false,
      isDefault: true,
      activeProfileId: 1,
      activeDirectory: '/media/Movies',
    },
  ]);
  service.getSonarrServices.mockResolvedValue([
    {
      id: 0,
      name: 'Sonarr',
      is4k: false,
      isDefault: true,
      activeProfileId: 2,
      activeDirectory: '/media/TV',
      activeAnimeDirectory: '/media/Anime',
    },
  ]);
  service.getRadarrDetail.mockResolvedValue({
    profiles: [{ id: 1, name: 'Any' }],
    rootFolders: [{ id: 1, path: '/media/Movies', freeSpace: 11231096471552 }],
  });
  service.getSonarrDetail.mockResolvedValue({
    profiles: [{ id: 2, name: 'HD-1080p' }],
    rootFolders: [{ id: 1, path: '/media/TV', freeSpace: 999 }],
    languageProfiles: null,
  });
}

describe('seerr_service_options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeHappyPath();
  });

  it('decodes capability flags and the media server, stripping vapidPublic/plexClientIdentifier', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await serviceOptionsTool.handler(serviceOptionsTool.input.parse({}), ctx);
    expect(result.instance).toEqual({
      version: '3.3.0',
      mediaServer: 'jellyfin',
      movie4kEnabled: true,
      series4kEnabled: true,
      partialRequestsEnabled: true,
      specialEpisodesEnabled: false,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('VAPID-PUBLIC-KEY-SECRET');
    expect(json).not.toContain('plex-uuid-secret');
  });

  it('REDACTS filesystem paths by default (no root folders, no activeDirectory)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await serviceOptionsTool.handler(serviceOptionsTool.input.parse({}), ctx);
    const json = JSON.stringify(result);
    expect(json).not.toContain('/media/Movies');
    expect(json).not.toContain('/media/TV');
    expect(json).not.toContain('/media/Anime');
    for (const svc of result.services) {
      expect(svc.rootFolders).toBeUndefined();
    }
  });

  it('surfaces root-folder paths + freeSpace only when includePaths:true', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await serviceOptionsTool.handler(
      serviceOptionsTool.input.parse({ includePaths: true }),
      ctx,
    );
    const radarr = result.services.find((s) => s.kind === 'radarr');
    expect(radarr?.rootFolders).toEqual([{ path: '/media/Movies', freeSpace: 11231096471552 }]);
  });

  it('resolves profile names from the detail endpoint and includes the server routing defaults', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await serviceOptionsTool.handler(
      serviceOptionsTool.input.parse({ service: 'radarr' }),
      ctx,
    );
    const radarr = result.services.find((s) => s.kind === 'radarr');
    expect(radarr).toMatchObject({
      serverId: 0,
      name: 'Radarr',
      isDefault: true,
      is4k: false,
      activeProfileId: 1,
    });
    expect(radarr?.profiles).toEqual([{ id: 1, name: 'Any' }]);
  });

  it('degrades gracefully with a notice when a service detail leg fails', async () => {
    service.getRadarrDetail.mockRejectedValue(new Error('boom'));
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await serviceOptionsTool.handler(
      serviceOptionsTool.input.parse({ service: 'radarr' }),
      ctx,
    );
    const radarr = result.services.find((s) => s.kind === 'radarr');
    expect(radarr?.profiles).toBeUndefined(); // detail failed → omitted
    expect(getEnrichment(ctx).notice).toContain('Radarr details unavailable');
  });
});
