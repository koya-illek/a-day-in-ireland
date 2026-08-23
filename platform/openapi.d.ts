export const OPENAPI_PATH: "/api/openapi.json";
export const OPENAPI_VERSION: string;
export const CONTEXT_SOURCE_NAMES: readonly string[];
export const openApiDocument: () => Record<string, unknown>;
export const openApiResponse: () => Response;
