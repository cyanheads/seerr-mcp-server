/**
 * @fileoverview Upstream-error classifier for the Seerr API. Seerr returns
 * idiosyncratic not-found responses that the generic HTTP-status mapping would
 * mislabel:
 *   - A missing TMDB movie/show id → HTTP 500 with body `{"message":"Unable to
 *     retrieve movie."}` (confirmed live). The generic mapping would call this a
 *     transient `ServiceUnavailable` and retry it — it never succeeds. We classify
 *     it as `media_not_found` (NotFound) so the agent re-searches instead.
 *   - A missing request id → HTTP 404 with body `{"message":"Request not found."}`
 *     → `request_not_found` (NotFound).
 *
 * The classifier is used for the GET endpoints that carry these semantics
 * (`/movie/{id}`, `/tv/{id}`, `/request/{id}`). It inspects status + body and
 * throws a domain-tagged `McpError`; callers declare matching `errors[]` contract
 * entries so `data.reason` lines up with `ctx.fail`. The thrown errors carry
 * `retryable: false` so `withRetry` fails fast rather than hammering a 500 that
 * will never resolve, and a static `recovery.hint` so the actionable next step
 * reaches both wire surfaces (the framework mirrors `data.recovery.hint` into the
 * `content[]` text). The classifier runs in the service layer without `ctx`, so
 * the hint is attached here rather than resolved from a tool's `recoveryFor`.
 * @module services/seerr/errors
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';

/** Which not-found-bearing endpoint a classified response belongs to. */
export type NotFoundKind = 'media' | 'request';

const MEDIA_NOT_FOUND_BODY = /unable to retrieve (movie|series|tv)/i;
const REQUEST_NOT_FOUND_BODY = /request not found/i;

/**
 * Static recovery hints mirrored to both wire surfaces. The text matches the
 * `errors[]` contract entries of the consuming tools (`seerr_get_media`,
 * `seerr_request_media`, `seerr_request_status`, and the request resource).
 */
const MEDIA_NOT_FOUND_RECOVERY =
  'Call seerr_search_media to find the correct tmdbId, then retry with the exact ID and matching mediaType.';
const REQUEST_NOT_FOUND_RECOVERY =
  'List requests with seerr_list_requests to find a valid requestId, then retry.';

/**
 * Inspect a non-OK `Response` from a not-found-bearing GET and throw the right
 * domain error. `kind` selects the expected not-found semantics. Falls back to the
 * framework's status-based mapping for anything that isn't the known not-found shape.
 *
 * Reads the response body once. The caller must not have consumed it.
 */
export async function throwClassifiedSeerrError(
  response: Response,
  kind: NotFoundKind,
  service: string,
): Promise<never> {
  const body = await response.text();

  if (
    kind === 'media' &&
    (response.status === 500 || response.status === 404) &&
    MEDIA_NOT_FOUND_BODY.test(body)
  ) {
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      'Unable to retrieve the requested title from Seerr.',
      {
        reason: 'media_not_found',
        httpStatus: response.status,
        retryable: false,
        recovery: { hint: MEDIA_NOT_FOUND_RECOVERY },
      },
    );
  }

  if (kind === 'request' && response.status === 404 && REQUEST_NOT_FOUND_BODY.test(body)) {
    throw new McpError(JsonRpcErrorCode.NotFound, 'Request not found.', {
      reason: 'request_not_found',
      httpStatus: response.status,
      retryable: false,
      recovery: { hint: REQUEST_NOT_FOUND_RECOVERY },
    });
  }

  /**
   * Not a recognized not-found shape — defer to the framework's full status table.
   * `captureBody: false` is the security boundary: a raw Seerr error body is the one
   * path that would reach output WITHOUT passing the `normalizers.ts` choke point,
   * and Seerr/Radarr/Sonarr error strings can echo `serviceUrl` (internal host:port)
   * or root-folder paths. Status + statusText carry enough for the agent to act.
   */
  throw await httpErrorFromResponse(
    new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    { service, captureBody: false },
  );
}
