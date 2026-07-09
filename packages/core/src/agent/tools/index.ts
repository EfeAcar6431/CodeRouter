/**
 * Tool registry: the agent's surface area to the world.
 *
 * To add a new tool:
 *   1. Drop a new file in this folder with `export const xxxTool: Tool = ...`.
 *   2. Add it to `defaultTools()` below.
 *   3. (Optional) call `withTool` / `withoutTool` from a custom adapter
 *      to compose a non-default set without forking `defaultTools`.
 */

import type { Tool } from '../types.js';

import { askUserQuestionTool } from './askUserQuestion.js';
import { bashTool } from './bash.js';
import { editFileTool } from './editFile.js';
import { generateImageTool } from './generateImage.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './listDir.js';
import { multiEditTool } from './multiEdit.js';
import { openPreviewTool } from './openPreview.js';
import { readFileTool } from './readFile.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { writeFileTool } from './writeFile.js';

/**
 * Default toolbox. Order is the order the model sees in the tools
 * list - we put read-only inspection tools first so the model
 * defaults to "look before you leap".
 */
export function defaultTools(): Tool[] {
  return [
    readFileTool,
    globTool,
    grepTool,
    listDirTool,
    webSearchTool,
    webFetchTool,
    writeFileTool,
    editFileTool,
    multiEditTool,
    generateImageTool,
    bashTool,
    openPreviewTool,
    askUserQuestionTool,
  ];
}

/** Add a tool to the set, replacing any existing entry with the same name. */
export function withTool(tools: Tool[], tool: Tool): Tool[] {
  return [...tools.filter((t) => t.name !== tool.name), tool];
}

/** Drop a tool by name. No-op if it isn't present. */
export function withoutTool(tools: Tool[], name: string): Tool[] {
  return tools.filter((t) => t.name !== name);
}

export {
  askUserQuestionTool,
  bashTool,
  editFileTool,
  generateImageTool,
  globTool,
  grepTool,
  listDirTool,
  multiEditTool,
  openPreviewTool,
  readFileTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
};
