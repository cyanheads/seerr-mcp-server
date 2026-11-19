/**
 * @fileoverview Tests for the PII/infra redaction choke point (`normalizers.ts`).
 * These are the security tests: a raw payload carrying every leaked field is run
 * through each projector and the output is asserted to contain NONE of the leaked
 * values — operator email, Plex/Jellyfin tokens, jellyfinUserId, serviceUrl,
 * filesystem paths. Both `requestedBy` and `modifiedBy` are exercised.
 * @module tests/services/seerr/normalizers.test
 */

import { describe, expect, it } from 'vitest';
import {
  duplicateBlockerId,
  projectRequestDetail,
  redactAvailability,
  redactLatestRequest,
  redactRootFolder,
  redactUser,
} from '@/services/seerr/normalizers.js';
import type { RawMediaInfo, RawMediaRequest, RawUser } from '@/services/seerr/types.js';

/**
 * A raw User object mirroring the live Seerr 3.3.0 `/request/{id}` payload — every
 * PII-bearing key the real API nests in `requestedBy`/`modifiedBy` is populated
 * (email, Jellyfin/Plex tokens + IDs, avatars, permissions bitfield, quotas,
 * recovery link, warnings, settings). The projector must drop all of them.
 */
const LEAKY_USER: RawUser = {
  id: 1,
  displayName: 'mediauser',
  username: 'mediauser',
  jellyfinUsername: 'mediauser_jf',
  plexUsername: 'mediauser_plex',
  email: 'operator@example.com',
  jellyfinUserId: 'jf-user-abcdef0123456789',
  plexId: 99887766,
  plexToken: 'PLEX-TOKEN-SECRET-xyz',
  jellyfinAuthToken: 'JF-AUTH-TOKEN-SECRET-xyz',
  avatar: 'https://plex.tv/users/abc/avatar?c=123',
  avatarETag: 'etag-SECRET-7788',
  avatarVersion: 4,
  permissions: 4194302,
  recoveryLinkExpirationDate: '2026-01-01T00:00:00.000Z',
  movieQuotaDays: 7,
  movieQuotaLimit: 10,
  tvQuotaDays: 7,
  tvQuotaLimit: 10,
  requestCount: 42,
  userType: 2,
  settings: { discordId: 'discord-SECRET-555', telegramChatId: 'tg-SECRET-666' },
  warnings: ['something'],
};

/** Every PII string that must never appear anywhere in projected output. */
const FORBIDDEN_SUBSTRINGS = [
  'operator@example.com',
  'jf-user-abcdef0123456789',
  'PLEX-TOKEN-SECRET-xyz',
  'JF-AUTH-TOKEN-SECRET-xyz',
  'plex.tv/users',
  'etag-SECRET-7788',
  '99887766',
  '4194302',
  'discord-SECRET-555',
  'tg-SECRET-666',
  '203.0.113.10',
  '/media/Movies',
  '/media/TV',
  '/media/Anime',
  'BBRJkvckubDyCI8tTSieU33p3BFkiq5jL4zqspofvRjAp4TAD30Boci',
  '6ae4010e-0714-4fa9-a179-329e8b4abff9',
];

/** Assert a projected value, serialized, leaks none of the forbidden substrings. */
function assertNoLeaks(value: unknown): void {
  const json = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    expect(json).not.toContain(forbidden);
  }
}

describe('redactUser', () => {
  it('projects a User to id + displayName only, dropping all PII', () => {
    const projected = redactUser(LEAKY_USER);
    expect(projected).toEqual({ id: 1, displayName: 'mediauser' });
    expect(Object.keys(projected)).toEqual(['id', 'displayName']);
    assertNoLeaks(projected);
  });

  it('falls back through username → jellyfinUsername → plexUsername → displayName → User #id', () => {
    expect(redactUser({ id: 5, jellyfinUsername: 'jf' }).displayName).toBe('jf');
    expect(redactUser({ id: 6, plexUsername: 'px' }).displayName).toBe('px');
    expect(redactUser({ id: 7, displayName: 'dn' }).displayName).toBe('dn');
    expect(redactUser({ id: 8 }).displayName).toBe('User #8');
  });
});

describe('redactAvailability', () => {
  it('reads only status/status4k from a leaky MediaInfo, dropping serviceUrl and IDs', () => {
    const media: RawMediaInfo = {
      id: 12,
      tmdbId: 1275779,
      status: 5,
      status4k: 3,
      serviceUrl: 'http://203.0.113.10:3106/movie/abc',
      serviceUrl4k: 'http://203.0.113.10:3107/movie/abc',
      jellyfinMediaId: 'jf-media-XYZ',
      ratingKey: 'rk-12345',
    };
    const projected = redactAvailability(media);
    expect(projected).toEqual({
      status: { raw: 5, label: 'available' },
      status4k: { raw: 3, label: 'processing' },
    });
    assertNoLeaks(projected);
  });

  it('omits status4k when absent and defaults missing status to unknown(1)', () => {
    expect(redactAvailability({})).toEqual({ status: { raw: 1, label: 'unknown' } });
  });
});

/**
 * The fixture behind #13/#16: an approved non-4K request (#45, January) and a
 * newer completed 4K request (#46, March). Seerr's duplicate check blocks a
 * non-4K submit on #45, while the latest request is #46.
 */
const MIXED_REQUESTS: RawMediaInfo = {
  requests: [
    { id: 45, status: 2, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 46, status: 5, is4k: true, createdAt: '2026-03-01T00:00:00.000Z' },
  ],
};

describe('redactLatestRequest', () => {
  it('reports the newest request at any quality and in any state', () => {
    expect(redactLatestRequest(MIXED_REQUESTS)).toEqual({
      requestId: 46,
      status: { raw: 5, label: 'completed' },
      is4k: true,
    });
  });

  it('picks the most recent request and projects it without requester PII', () => {
    const media: RawMediaInfo = {
      requests: [
        {
          id: 10,
          status: 2,
          is4k: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          requestedBy: LEAKY_USER,
        },
        {
          id: 11,
          status: 1,
          is4k: true,
          createdAt: '2026-02-01T00:00:00.000Z',
          requestedBy: LEAKY_USER,
        },
      ],
    };
    const projected = redactLatestRequest(media);
    expect(projected).toEqual({ requestId: 11, status: { raw: 1, label: 'pending' }, is4k: true });
    assertNoLeaks(projected);
  });

  it('returns undefined when there are no requests', () => {
    expect(redactLatestRequest({})).toBeUndefined();
    expect(redactLatestRequest(undefined)).toBeUndefined();
  });
});

describe('duplicateBlockerId', () => {
  it('names the first same-quality movie request while it still blocks', () => {
    expect(duplicateBlockerId(MIXED_REQUESTS, 'movie', false)).toBe(45);
    // #46 is the only 4K request, and it is completed — Seerr's first-row rule passes it.
    expect(duplicateBlockerId(MIXED_REQUESTS, 'movie', true)).toBeUndefined();
  });

  it.each([
    ['pending', 1, 10],
    ['approved', 2, 10],
    ['failed', 4, 10],
    ['declined', 3, undefined],
    ['completed', 5, undefined],
  ])(
    'a first request that is %s (status %i), beside a newer pending one → %s',
    (_label, status, expected) => {
      const media: RawMediaInfo = {
        requests: [
          { id: 11, status: 1, is4k: false, createdAt: '2026-02-01T00:00:00.000Z' },
          { id: 10, status, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      };
      expect(duplicateBlockerId(media, 'movie', false)).toBe(expected);
    },
  );

  it('takes the first request by lowest id, not by array position or createdAt', () => {
    const media: RawMediaInfo = {
      requests: [
        { id: 53, status: 2, is4k: false, createdAt: '2026-03-01T00:00:00.000Z' },
        { id: 51, status: 1, is4k: false, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 55, status: 4, is4k: false, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    expect(duplicateBlockerId(media, 'movie', false)).toBe(51);
  });

  it('looks only at requests of the submitted quality', () => {
    const media: RawMediaInfo = {
      requests: [
        { id: 40, status: 2, is4k: true },
        { id: 41, status: 3, is4k: false },
        { id: 42, status: 2, is4k: false },
      ],
    };
    // #40 is the lowest id overall, but it is 4K; the non-4K first request #41 is declined.
    expect(duplicateBlockerId(media, 'movie', false)).toBeUndefined();
    expect(duplicateBlockerId(media, 'movie', true)).toBe(40);
  });

  it('counts a request without is4k as non-4K', () => {
    const media: RawMediaInfo = { requests: [{ id: 45, status: 2 }] };
    expect(duplicateBlockerId(media, 'movie', false)).toBe(45);
    expect(duplicateBlockerId(media, 'movie', true)).toBeUndefined();
  });

  it.each([
    ['no status', undefined],
    ['an unrecognized status', 9],
  ])(
    'names none when the first request has %s, without falling through to the next',
    (_case, status) => {
      const media: RawMediaInfo = {
        requests: [
          { id: 11, status: 2, is4k: false },
          { id: 10, is4k: false, ...(status === undefined ? {} : { status }) },
        ],
      };
      expect(duplicateBlockerId(media, 'movie', false)).toBeUndefined();
    },
  );

  it('never names a request for TV, where every 409 comes from the auto-request rule', () => {
    expect(duplicateBlockerId(MIXED_REQUESTS, 'tv', false)).toBeUndefined();
    expect(duplicateBlockerId({ requests: [{ id: 70, status: 1 }] }, 'tv', false)).toBeUndefined();
  });

  it('returns undefined when there are no requests', () => {
    expect(duplicateBlockerId({}, 'movie', false)).toBeUndefined();
    expect(duplicateBlockerId({ requests: [] }, 'movie', false)).toBeUndefined();
    expect(duplicateBlockerId(undefined, 'movie', true)).toBeUndefined();
  });
});

describe('redactRootFolder', () => {
  it('omits the folder entirely when includePaths is false (path is operator-private)', () => {
    expect(
      redactRootFolder({ id: 1, path: '/media/Movies', freeSpace: 123 }, false),
    ).toBeUndefined();
  });

  it('surfaces path + freeSpace only when includePaths is true', () => {
    expect(redactRootFolder({ id: 1, path: '/media/Movies', freeSpace: 123 }, true)).toEqual({
      path: '/media/Movies',
      freeSpace: 123,
    });
  });
});

describe('projectRequestDetail — full request redaction (requestedBy AND modifiedBy)', () => {
  const leakyRequest: RawMediaRequest = {
    id: 45,
    type: 'movie',
    status: 2,
    is4k: false,
    seasons: [],
    profileName: null,
    serverId: 0,
    rootFolder: '/media/Movies',
    languageProfileId: null,
    createdAt: '2026-06-08T10:50:48.000Z',
    updatedAt: '2026-06-08T10:50:48.000Z',
    requestedBy: LEAKY_USER,
    modifiedBy: { ...LEAKY_USER, id: 1 },
    media: {
      tmdbId: 1275779,
      status: 3,
      status4k: 1,
      serviceUrl: 'http://203.0.113.10:3106/movie/abc',
      jellyfinMediaId: 'jf-media-XYZ',
    },
  };

  it('projects to a redacted detail with no PII from requestedBy or modifiedBy', () => {
    const detail = projectRequestDetail(leakyRequest);
    expect(detail.requestId).toBe(45);
    expect(detail.mediaType).toBe('movie');
    expect(detail.requestStatus).toEqual({ raw: 2, label: 'approved' });
    expect(detail.requestedBy).toEqual({ id: 1, displayName: 'mediauser' });
    expect(detail.routing).toEqual({ serverId: 0, is4k: false });
    expect(detail.tmdbId).toBe(1275779);
    // rootFolder (a filesystem path) is NOT projected into the detail at all.
    expect(JSON.stringify(detail)).not.toContain('/media/Movies');
    assertNoLeaks(detail);
  });

  it('maps the raw `type` field (not mediaType) to the output mediaType', () => {
    expect(projectRequestDetail({ ...leakyRequest, type: 'tv' }).mediaType).toBe('tv');
    expect(projectRequestDetail({ ...leakyRequest, type: 'movie' }).mediaType).toBe('movie');
  });

  it('omits profileName from routing when null (absent at the single-request endpoint)', () => {
    const detail = projectRequestDetail(leakyRequest);
    expect(detail.routing.profileName).toBeUndefined();
  });
});

describe('projectRequestDetail — stateGuidance follows the resolution that was requested', () => {
  /** An approved 4K request: the 4K copy is downloading while the non-4K pipeline is untouched. */
  const fourKRequest: RawMediaRequest = {
    id: 47,
    type: 'movie',
    status: 2,
    is4k: true,
    createdAt: '2026-06-08T10:50:48.000Z',
    updatedAt: '2026-06-08T10:50:48.000Z',
    requestedBy: LEAKY_USER,
    media: { tmdbId: 1275779, status: 1, status4k: 3 },
  };

  it('reads status4k for an is4k request instead of the unknown non-4K status', () => {
    const detail = projectRequestDetail(fourKRequest);
    expect(detail.mediaStatus).toEqual({ raw: 1, label: 'unknown' });
    expect(detail.mediaStatus4k).toEqual({ raw: 3, label: 'processing' });
    expect(detail.stateGuidance).toBe(
      'Approved and downloading via Radarr/Sonarr. Check back shortly.',
    );
  });

  it('reads status for a non-4K request even when status4k is further along', () => {
    const detail = projectRequestDetail({ ...fourKRequest, id: 48, is4k: false });
    expect(detail.stateGuidance).toContain('no download has started');
  });

  it('falls back to status when an is4k request carries no status4k', () => {
    const detail = projectRequestDetail({
      ...fourKRequest,
      media: { tmdbId: 1275779, status: 5 },
    });
    expect(detail.mediaStatus4k).toBeUndefined();
    expect(detail.stateGuidance).toBe('Media is available to watch.');
  });
});
