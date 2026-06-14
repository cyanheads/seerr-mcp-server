#!/usr/bin/env node
/**
 * @fileoverview seerr-mcp-server MCP server entry point. Wires the SeerrService in
 * setup() and registers the six tools + one resource. Identity is name + title
 * only (the hyphenated machine name) — description derives from package.json.
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
  instructions:
    'Local Seerr request workflow. Search first (seerr_search_media), confirm the exact title ' +
    '(seerr_get_media), then request via seerr_request_media — which defaults to mode:preview and ' +
    'only writes on mode:request. "Download X" means "create a Seerr request for X"; never bypass to Radarr/Sonarr.',
  setup(core) {
    initSeerrService(core.config, core.storage);
  },
});
