/**
 * @fileoverview Server-specific environment configuration for seerr-mcp-server.
 * Lazy-parsed Zod schema, separate from the framework's core config. Maps schema
 * paths to env var names via `parseEnvConfig` so startup errors name the variable
 * (`SEERR_BASE_URL is missing`) rather than the schema path.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Seerr connection + behavior config. `baseUrl` and `apiKey` are required — the
 * server cannot reach the instance without them. The base URL must omit the
 * `/api/v1` suffix (the service appends it) and carry no trailing slash.
 */
const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .describe(
      'Seerr instance base URL, e.g. http://host:5055. No /api/v1 suffix, no trailing slash.',
    ),
  apiKey: z
    .string()
    .min(1)
    .describe('Seerr API key (Settings → General → API Key). Sent as the X-Api-Key header.'),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(15000)
    .describe('Per-request HTTP timeout in milliseconds.'),
});

export type SeerrServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: SeerrServerConfig | undefined;

/**
 * Lazily parse and cache the server config from the environment. Lazy parsing
 * keeps top-level `process.env` reads out of module load so the Workers runtime
 * (which injects env at request time) stays compatible.
 */
export function getServerConfig(): SeerrServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'SEERR_BASE_URL',
    apiKey: 'SEERR_API_KEY',
    requestTimeoutMs: 'SEERR_REQUEST_TIMEOUT_MS',
  });
  return _config;
}
