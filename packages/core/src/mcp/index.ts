/**
 * MCP client layer: lets CodeRouter's first-party agent loop consume tools
 * from external Model Context Protocol servers (graphify being the first).
 *
 * Public surface:
 *   - config:  load/save/remove server entries, graphify preset
 *   - runtime: getMcpToolsForCwd (used by the agent adapter), disposeAllMcp
 *   - CLI aid: probeMcpServer, listMcpServers
 */
export type { McpServerConfig, McpFile, McpToolInfo } from './types.js';
export {
  loadMcpServers,
  listMcpServers,
  saveMcpServer,
  removeMcpServer,
  graphifyPreset,
  projectMcpPath,
  globalMcpPath,
} from './config.js';
export { getMcpToolsForCwd, disposeAllMcp, probeMcpServer } from './manager.js';
export { McpClient } from './client.js';
export { mcpToolToTool, mcpToolName, normalizeSchema } from './toTool.js';
