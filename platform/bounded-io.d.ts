export function readBoundedResponseBytes(
  response: Response,
  label: string,
  maximumBytes: number
): Promise<Uint8Array>;
export function readBoundedJsonResponse(
  response: Response,
  label: string,
  maximumBytes: number
): Promise<{ body: unknown; bodyBytes: number }>;
export function readBoundedTextResponse(
  response: Response,
  label: string,
  maximumBytes: number
): Promise<string>;
