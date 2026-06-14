/**
 * @fileoverview Tests for the pure status decoders. Verifies the request (1–5) and
 * media (1–7) decodings against Seerr's `MediaRequestStatus` / `MediaStatus` enums,
 * the media-server map, the `{ raw, label }` contract, and that unknown codes
 * degrade to `unrecognized` rather than throwing. The 4/5 request statuses and the
 * 6=blocklisted / 7=deleted media statuses are confirmed against live Seerr 3.3.0.
 * @module tests/services/seerr/status.test
 */

import { describe, expect, it } from 'vitest';
import {
  decodeMediaServer,
  decodeMediaStatus,
  decodeRequestStatus,
  statusText,
} from '@/services/seerr/status.js';

describe('decodeRequestStatus', () => {
  it('decodes the full 1–5 request-status scale', () => {
    expect(decodeRequestStatus(1)).toEqual({ raw: 1, label: 'pending' });
    expect(decodeRequestStatus(2)).toEqual({ raw: 2, label: 'approved' });
    expect(decodeRequestStatus(3)).toEqual({ raw: 3, label: 'declined' });
    // 4 (failed) and 5 (completed) appear on real requests — live-confirmed.
    expect(decodeRequestStatus(4)).toEqual({ raw: 4, label: 'failed' });
    expect(decodeRequestStatus(5)).toEqual({ raw: 5, label: 'completed' });
  });

  it('degrades unknown codes to unrecognized, preserving the raw value', () => {
    expect(decodeRequestStatus(99)).toEqual({ raw: 99, label: 'unrecognized' });
  });
});

describe('decodeMediaStatus', () => {
  it('decodes the full 1–7 media-status scale (6=blocklisted, 7=deleted)', () => {
    expect(decodeMediaStatus(1).label).toBe('unknown');
    expect(decodeMediaStatus(2).label).toBe('pending');
    expect(decodeMediaStatus(3).label).toBe('processing');
    expect(decodeMediaStatus(4).label).toBe('partially_available');
    expect(decodeMediaStatus(5).label).toBe('available');
    expect(decodeMediaStatus(6).label).toBe('blocklisted');
    expect(decodeMediaStatus(7).label).toBe('deleted');
  });

  it('degrades unknown codes to unrecognized', () => {
    expect(decodeMediaStatus(0)).toEqual({ raw: 0, label: 'unrecognized' });
  });
});

describe('decodeMediaServer', () => {
  it('maps 1/2/3 to plex/jellyfin/emby', () => {
    expect(decodeMediaServer(1)).toBe('plex');
    expect(decodeMediaServer(2)).toBe('jellyfin');
    expect(decodeMediaServer(3)).toBe('emby');
    expect(decodeMediaServer(0)).toBe('unrecognized');
  });
});

describe('statusText', () => {
  it('renders a decoded status as "label (raw)" for format-parity', () => {
    expect(statusText({ raw: 5, label: 'available' })).toBe('available (5)');
  });
});
