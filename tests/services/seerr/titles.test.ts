/**
 * @fileoverview Tests for the title-hydration join. Headline: resolve request
 * titles from the media endpoints without letting a page of requests fan out
 * unbounded. Covers: de-duplication of repeated (mediaType, tmdbId) pairs, the
 * exact concurrency width under a 100-row page plus the single-key and empty-key
 * edges, the single-attempt retry budget every leg runs under, each degradation
 * mode (throw, blank title, no tmdbId), and the single-detail hydrate used by
 * seerr_request_status and the request resource.
 * @module tests/services/seerr/titles.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { DomainRequestDetail } from '@/services/seerr/normalizers.js';
import type { SeerrService } from '@/services/seerr/seerr-service.js';
import { hydrateRequestTitle, resolveTitles, titleKeyOf } from '@/services/seerr/titles.js';

/** A SeerrService stand-in exposing only the two detail reads hydration uses. */
const asService = (partial: Partial<SeerrService>) => partial as unknown as SeerrService;

const detail = (tmdbId: number | undefined): DomainRequestDetail => ({
  requestId: 47,
  mediaType: 'movie',
  requestStatus: { raw: 2, label: 'approved' },
  is4k: false,
  requestedBy: { id: 1, displayName: 'mediauser' },
  routing: { is4k: false },
  createdAt: '2026-06-08T10:50:48.000Z',
  updatedAt: '2026-06-08T10:50:48.000Z',
  ...(tmdbId === undefined ? {} : { tmdbId }),
});

describe('resolveTitles', () => {
  it('collapses repeated keys to one fetch and fans the title back out', async () => {
    const getMovie = vi.fn(async (tmdbId: number) => ({ id: tmdbId, title: 'Avengers: Endgame' }));
    const ctx = createMockContext({ tenantId: 'test' });

    const lookup = await resolveTitles(
      [
        { mediaType: 'movie', tmdbId: 299534 },
        { mediaType: 'movie', tmdbId: 299534 },
        { mediaType: 'movie', tmdbId: 299534 },
      ],
      asService({ getMovie }),
      ctx,
    );

    expect(getMovie).toHaveBeenCalledTimes(1);
    expect(lookup.uniqueKeys).toBe(1);
    expect(lookup.titles.get(titleKeyOf('movie', 299534))).toBe('Avengers: Endgame');
  });

  it('keys movie and tv separately for the same tmdbId', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const lookup = await resolveTitles(
      [
        { mediaType: 'movie', tmdbId: 1399 },
        { mediaType: 'tv', tmdbId: 1399 },
      ],
      asService({
        getMovie: vi.fn(async (tmdbId: number) => ({ id: tmdbId, title: 'A Movie' })),
        getTv: vi.fn(async (tmdbId: number) => ({ id: tmdbId, name: 'A Show' })),
      }),
      ctx,
    );

    expect(lookup.uniqueKeys).toBe(2);
    expect(lookup.titles.get(titleKeyOf('movie', 1399))).toBe('A Movie');
    expect(lookup.titles.get(titleKeyOf('tv', 1399))).toBe('A Show');
  });

  /**
   * `take` caps at 100, so a full page must not open 100 sockets on a self-hosted
   * host — and must not silently collapse to a narrower window either, which is why
   * the peak is asserted exactly rather than as a ceiling.
   */
  it('holds exactly 6 lookups in flight across a 100-key page', async () => {
    let inFlight = 0;
    let peak = 0;
    const getMovie = vi.fn(async (tmdbId: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { id: tmdbId, title: `Title ${tmdbId}` };
    });
    const ctx = createMockContext({ tenantId: 'test' });

    const keys = Array.from({ length: 100 }, (_, i) => ({
      mediaType: 'movie' as const,
      tmdbId: 1000 + i,
    }));
    const lookup = await resolveTitles(keys, asService({ getMovie }), ctx);

    expect(getMovie).toHaveBeenCalledTimes(100);
    expect(lookup.titles.size).toBe(100);
    expect(peak).toBe(6);
  });

  /** Fewer keys than the pool width: one worker per key, no idle spin, no double-pull. */
  it('runs a single key on a single worker', async () => {
    let inFlight = 0;
    let peak = 0;
    const getMovie = vi.fn(async (tmdbId: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { id: tmdbId, title: 'Fight Club' };
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const lookup = await resolveTitles(
      [{ mediaType: 'movie', tmdbId: 550 }],
      asService({ getMovie }),
      ctx,
    );

    expect(peak).toBe(1);
    expect(getMovie).toHaveBeenCalledTimes(1);
    expect(lookup.uniqueKeys).toBe(1);
  });

  /** Every row on the page lacked a tmdbId — the pass must resolve, not hang on zero workers. */
  it('resolves an empty key set without fetching', async () => {
    const getMovie = vi.fn();
    const ctx = createMockContext({ tenantId: 'test' });
    const lookup = await resolveTitles([], asService({ getMovie }), ctx);

    expect(getMovie).not.toHaveBeenCalled();
    expect(lookup.uniqueKeys).toBe(0);
    expect(lookup.titles.size).toBe(0);
  });

  /** A cosmetic lookup must not inherit the retry budget of a required read. */
  it('makes each leg single-attempt so a flaky detail read cannot amplify', async () => {
    const getMovie = vi.fn(async (tmdbId: number) => ({ id: tmdbId, title: 'Fight Club' }));
    const getTv = vi.fn(async (tmdbId: number) => ({ id: tmdbId, name: 'Game of Thrones' }));
    const ctx = createMockContext({ tenantId: 'test' });
    await resolveTitles(
      [
        { mediaType: 'movie', tmdbId: 550 },
        { mediaType: 'tv', tmdbId: 1399 },
      ],
      asService({ getMovie, getTv }),
      ctx,
    );

    expect(getMovie).toHaveBeenCalledWith(550, ctx, { maxRetries: 0 });
    expect(getTv).toHaveBeenCalledWith(1399, ctx, { maxRetries: 0 });
  });

  it('absorbs a throwing lookup without rejecting the pass', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const lookup = await resolveTitles(
      [
        { mediaType: 'movie', tmdbId: 299534 },
        { mediaType: 'movie', tmdbId: 404404 },
      ],
      asService({
        getMovie: vi.fn(async (tmdbId: number) => {
          if (tmdbId === 404404) throw new Error('Unable to retrieve movie.');
          return { id: tmdbId, title: 'Avengers: Endgame' };
        }),
      }),
      ctx,
    );

    expect(lookup.uniqueKeys).toBe(2);
    expect(lookup.titles.size).toBe(1);
    expect(lookup.titles.get(titleKeyOf('movie', 404404))).toBeUndefined();
  });

  it('treats a blank upstream title as unresolved', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const lookup = await resolveTitles(
      [{ mediaType: 'movie', tmdbId: 299534 }],
      asService({ getMovie: vi.fn(async (tmdbId: number) => ({ id: tmdbId, title: '   ' })) }),
      ctx,
    );

    expect(lookup.uniqueKeys).toBe(1);
    expect(lookup.titles.size).toBe(0);
  });
});

describe('hydrateRequestTitle', () => {
  it('attaches the resolved title to a projected detail', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await hydrateRequestTitle(
      detail(299534),
      asService({ getMovie: vi.fn(async () => ({ id: 299534, title: 'Avengers: Endgame' })) }),
      ctx,
    );
    expect(result.title).toBe('Avengers: Endgame');
  });

  it('returns the detail untouched when there is no tmdbId to look up', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const getMovie = vi.fn();
    const input = detail(undefined);
    const result = await hydrateRequestTitle(input, asService({ getMovie }), ctx);

    expect(getMovie).not.toHaveBeenCalled();
    expect(result).toBe(input);
  });

  it('returns the detail untouched when the lookup throws', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = detail(404404);
    const result = await hydrateRequestTitle(
      input,
      asService({ getMovie: vi.fn(async () => Promise.reject(new Error('upstream busy'))) }),
      ctx,
    );

    expect(result.title).toBeUndefined();
    expect(result).toMatchObject({ requestId: 47, tmdbId: 404404 });
  });

  it('reads a tv detail through getTv, single-attempt', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const getTv = vi.fn(async () => ({ id: 1399, name: 'Game of Thrones' }));
    const result = await hydrateRequestTitle(
      { ...detail(1399), mediaType: 'tv' },
      asService({ getTv }),
      ctx,
    );

    expect(getTv).toHaveBeenCalledWith(1399, ctx, { maxRetries: 0 });
    expect(result.title).toBe('Game of Thrones');
  });
});
