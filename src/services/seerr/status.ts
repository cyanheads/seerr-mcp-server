/**
 * @fileoverview Pure status decoders for Seerr's numeric status enums. Every tool
 * output that carries a request status, media availability, or media-server type
 * emits a decoded `{ raw, label }` object via these helpers — never a bare number
 * or bare string. Unknown codes degrade to `{ raw, label: 'unrecognized' }` rather
 * than throwing, so a future Seerr status code still surfaces its raw value.
 * @module services/seerr/status
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Shared Zod shape for a decoded status. Reused across every tool output and the
 * resource so the `{ raw, label }` contract is identical everywhere.
 */
export const StatusRef = z
  .object({
    raw: z.number().describe('Raw numeric status code from the Seerr API.'),
    label: z.string().describe('Human-readable decoded label for the status code.'),
  })
  .describe('Decoded status: the raw numeric code plus its human-readable label.');

export type DecodedStatus = z.infer<typeof StatusRef>;

/**
 * `MediaRequest.status` codes (request lifecycle). Matches Jellyseerr/Seerr's
 * `MediaRequestStatus` enum. Live Seerr 3.3.0 emits 4 (failed) and 5 (completed)
 * on real requests — over half the requests on a working instance are status 5 —
 * so decoding only 1-3 mislabels every completed/failed request as `unrecognized`.
 */
const REQUEST_STATUS_LABELS: Record<number, string> = {
  1: 'pending',
  2: 'approved',
  3: 'declined',
  4: 'failed',
  5: 'completed',
};

/**
 * `MediaInfo.status` / `MediaInfo.status4k` codes (availability lifecycle). Matches
 * Jellyseerr/Seerr's `MediaStatus` enum: 6 is `blocklisted` and 7 is `deleted`
 * (BLOCKLISTED was inserted at 6, shifting DELETED to 7) — mapping 6 to `deleted`
 * mislabels a blocklisted item and leaves an actually-deleted item `unrecognized`.
 */
const MEDIA_STATUS_LABELS: Record<number, string> = {
  1: 'unknown',
  2: 'pending',
  3: 'processing',
  4: 'partially_available',
  5: 'available',
  6: 'blocklisted',
  7: 'deleted',
};

/** `mediaServerType` setting codes. */
const MEDIA_SERVER_LABELS: Record<number, string> = {
  1: 'plex',
  2: 'jellyfin',
  3: 'emby',
};

/** Decode a `MediaRequest.status` numeric code to `{ raw, label }`. */
export function decodeRequestStatus(raw: number): DecodedStatus {
  return { raw, label: REQUEST_STATUS_LABELS[raw] ?? 'unrecognized' };
}

/** Decode a `MediaInfo.status` / `status4k` numeric code to `{ raw, label }`. */
export function decodeMediaStatus(raw: number): DecodedStatus {
  return { raw, label: MEDIA_STATUS_LABELS[raw] ?? 'unrecognized' };
}

/** Decode a `mediaServerType` setting code to its label (plex | jellyfin | emby | unrecognized). */
export function decodeMediaServer(raw: number): string {
  return MEDIA_SERVER_LABELS[raw] ?? 'unrecognized';
}

/** Render a decoded status for `format()` output as `label (raw)` — surfaces both halves so format-parity holds. */
export function statusText(status: DecodedStatus): string {
  return `${status.label} (${status.raw})`;
}
