/**
 * @fileoverview Upstream-error classifier for the Seerr API. Several Seerr
 * endpoints give a status a meaning the generic HTTP-status mapping would
 * mislabel:
 *   - A missing TMDB movie/show id → HTTP 500 with body `{"message":"Unable to
 *     retrieve movie."}` (confirmed live). The generic mapping would call this a
 *     transient `ServiceUnavailable` and retry it — it never succeeds. We classify
 *     it as `media_not_found` (NotFound) so the agent re-searches instead.
 *   - A season the show doesn't have → HTTP 500 with body `{"message":"Unable to
 *     retrieve season."}` from `GET /tv/{id}/season/{n}` → `season_not_found`
 *     (NotFound). Seerr sends both not-found 500s when TMDB itself fails too; the
 *     classifier reads them as not-found regardless, and the messages say "unable
 *     to retrieve" rather than "does not exist".
 *   - A missing request id → HTTP 404 with body `{"message":"Request not found."}`
 *     → `request_not_found` (NotFound).
 *   - `GET /request` takes no body, so its HTTP 400 is always a query parameter or
 *     value the instance's version does not accept → `unsupported_filter`.
 *   - `POST /request` answers a same-quality duplicate with HTTP 409 and a
 *     `{ message }` body that names no request → `duplicate_request`.
 *
 * Each endpoint passes its `SeerrEndpoint`, and the classifier keys on the pair of
 * endpoint and status. It throws a domain-tagged `McpError`; the consuming tools
 * declare matching `errors[]` contract entries so `data.reason` lines up with
 * `ctx.fail`. The thrown errors carry `retryable: false` so `withRetry` fails fast
 * rather than hammering a response that will never change. `media_not_found` and
 * `request_not_found` also attach their static `recovery.hint` here; the others
 * take theirs from the declaring tool's contract, which the framework fills by
 * reason.
 * @module services/seerr/errors
 */

import { invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';

/**
 * The Seerr endpoint a non-OK response came from: `media` for the movie and TV
 * detail reads, `season` for `GET /tv/{id}/season/{n}`, `request` for
 * `GET /request/{id}`, `requestList` for `GET /request`, and `requestCreate` for
 * `POST /request`.
 */
export type SeerrEndpoint = 'media' | 'season' | 'request' | 'requestList' | 'requestCreate';

const MEDIA_NOT_FOUND_BODY = /unable to retrieve (movie|series|tv)/i;
const SEASON_NOT_FOUND_BODY = /unable to retrieve season/i;
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
 * Inspect a non-OK `Response` and throw the right domain error for the endpoint it
 * came from. Falls back to the framework's status-based mapping for anything that
 * isn't one of the endpoint's known shapes.
 *
 * Reads the response body once. The caller must not have consumed it.
 */
export async function throwClassifiedSeerrError(
  response: Response,
  kind: SeerrEndpoint,
  service: string,
): Promise<never> {
  const body = await response.text();

  /**
   * The two shapes below are told apart by status alone. Their bodies name the
   * rejected parameter or the duplicate, but no Seerr error body reaches output
   * (see the fallback below), so neither is read.
   */
  if (kind === 'requestList' && response.status === 400) {
    throw invalidParams('Seerr rejected the request-list query.', {
      reason: 'unsupported_filter',
      httpStatus: response.status,
      retryable: false,
    });
  }

  if (kind === 'requestCreate' && response.status === 409) {
    throw invalidParams('Seerr refused the request: a matching request already exists.', {
      reason: 'duplicate_request',
      httpStatus: response.status,
      retryable: false,
    });
  }

  if (
    kind === 'media' &&
    (response.status === 500 || response.status === 404) &&
    MEDIA_NOT_FOUND_BODY.test(body)
  ) {
    throw notFound('Unable to retrieve the requested title from Seerr.', {
      reason: 'media_not_found',
      httpStatus: response.status,
      retryable: false,
      recovery: { hint: MEDIA_NOT_FOUND_RECOVERY },
    });
  }

  if (kind === 'season' && response.status === 500 && SEASON_NOT_FOUND_BODY.test(body)) {
    throw notFound('Unable to retrieve the requested season from Seerr.', {
      reason: 'season_not_found',
      httpStatus: response.status,
      retryable: false,
    });
  }

  if (kind === 'request' && response.status === 404 && REQUEST_NOT_FOUND_BODY.test(body)) {
    throw notFound('Request not found.', {
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
