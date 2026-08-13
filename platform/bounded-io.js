const bodyLimitError = (label, cause = undefined) => new Error(
  `${label}-body-too-large`,
  cause === undefined ? undefined : { cause }
);

const cancelBody = async (body, label) => {
  if (!body) return null;
  try {
    await body.cancel(`${label}-body-too-large`);
    return null;
  } catch (error) {
    return error;
  }
};

export const readBoundedResponseBytes = async (response, label, maximumBytes) => {
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("maximumBytes must be a positive integer");
  }
  const contentLength = response.headers?.get?.("content-length");
  const declared = contentLength === null || contentLength === undefined ? Number.NaN : Number(contentLength);
  if (Number.isFinite(declared) && declared >= maximumBytes) {
    throw bodyLimitError(label, await cancelBody(response.body, label) ?? undefined);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total >= maximumBytes) {
        let cancellationError;
        try {
          await reader.cancel(`${label}-body-too-large`);
        } catch (error) {
          cancellationError = error;
        }
        throw bodyLimitError(label, cancellationError);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const readBoundedJsonResponse = async (response, label, maximumBytes) => {
  const bytes = await readBoundedResponseBytes(response, label, maximumBytes);
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)), bodyBytes: bytes.byteLength };
  } catch (error) {
    throw new Error(`${label}-malformed-json`, { cause: error });
  }
};

export const readBoundedTextResponse = async (response, label, maximumBytes) =>
  new TextDecoder().decode(await readBoundedResponseBytes(response, label, maximumBytes));
