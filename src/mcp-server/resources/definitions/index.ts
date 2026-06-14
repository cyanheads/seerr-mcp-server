/**
 * @fileoverview Barrel collecting every resource definition into
 * `allResourceDefinitions` for `createApp()`.
 * @module mcp-server/resources/definitions/index
 */

import { seerrRequestResource } from './request.resource.js';

export const allResourceDefinitions = [seerrRequestResource];
