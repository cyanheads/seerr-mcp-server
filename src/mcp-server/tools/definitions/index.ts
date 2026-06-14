/**
 * @fileoverview Barrel collecting every tool definition into `allToolDefinitions`
 * for `createApp()`. The agent workflow is: discover (search) → confirm (get) →
 * understand routing (service_options) → request (request_media) → track
 * (request_status / list_requests).
 * @module mcp-server/tools/definitions/index
 */

import { getMediaTool } from './get-media.tool.js';
import { listRequestsTool } from './list-requests.tool.js';
import { requestMediaTool } from './request-media.tool.js';
import { requestStatusTool } from './request-status.tool.js';
import { searchMediaTool } from './search-media.tool.js';
import { serviceOptionsTool } from './service-options.tool.js';

export const allToolDefinitions = [
  searchMediaTool,
  getMediaTool,
  listRequestsTool,
  requestMediaTool,
  requestStatusTool,
  serviceOptionsTool,
];
