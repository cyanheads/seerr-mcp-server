#!/usr/bin/env node
/**
 * @fileoverview seerr-mcp-server MCP server entry point. Wires the SeerrService in
 * setup() and registers the six tools + one resource. Identity is name + title
 * only (the hyphenated machine name) — description derives from package.json.
 * The HTTP session posture is declared here rather than left to a deployment's
 * MCP_SESSION_MODE, because seerr_request_media's confirmation round is not
 * optional to this server's guarantee.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initSeerrService } from './services/seerr/seerr-service.js';

await createApp({
  name: 'seerr-mcp-server',
  title: 'seerr-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  /**
   * The guarded write gates on `ctx.requestInput`, which a 2025-era HTTP client can
   * only answer over a live session. `require: 'stateful'` turns a `stateless`
   * deployment into a startup ConfigurationError instead of a silently unusable
   * `seerr_request_media`; a stdio start is never refused.
   */
  sessionMode: { require: 'stateful' },
  instructions:
    'Local Seerr request workflow. Search first (seerr_search_media), confirm the exact title ' +
    '(seerr_get_media), then request via seerr_request_media — which defaults to mode:preview and ' +
    'only writes on mode:request. "Download X" means "create a Seerr request for X"; never bypass to Radarr/Sonarr.',
  setup(core) {
    initSeerrService(core.config, core.storage);
  },
});
