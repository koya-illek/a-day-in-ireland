export const MCP_PATHS: readonly string[];
export const MCP_PROTOCOL_VERSIONS: readonly string[];
export const TRANSIT_TOOL_LIMIT_DEFAULT: number;
export const mcpTools: () => Array<Record<string, unknown>>;
export const buildToolImplementations: (sources: {
  living: () => Promise<Response>;
  transit: () => Promise<Response>;
  contexts: () => Promise<Response>;
  historySnapshot: (at: string) => Promise<Response>;
  historyRange: () => Promise<Response>;
}) => Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;
export const handleMcpRequest: (request: Request, sources: {
  living: () => Promise<Response>;
  transit: () => Promise<Response>;
  contexts: () => Promise<Response>;
  historySnapshot: (at: string) => Promise<Response>;
  historyRange: () => Promise<Response>;
}) => Promise<Response>;
