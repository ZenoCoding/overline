export class ApiKeyFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiKeyFormatError";
  }
}

export function normalizeApiKey(raw) {
  if (typeof raw !== "string") {
    throw new ApiKeyFormatError("OPENAI_API_KEY is not set. Enter the key at the hidden prompt and retry.");
  }

  // Normalize only surrounding ASCII whitespace commonly introduced by paste.
  const normalized = raw.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (!normalized) {
    throw new ApiKeyFormatError("The API key was empty after trimming surrounding whitespace. Re-enter it at the hidden prompt.");
  }
  if (normalized.startsWith("\"") || normalized.endsWith("\"")
      || normalized.startsWith("'") || normalized.endsWith("'")) {
    throw new ApiKeyFormatError("The API key appears to include surrounding quotes. Re-enter the raw key without quotes.");
  }
  if (/[^\x21-\x7E]/.test(normalized) || /[\x00-\x20\x7F]/.test(normalized)) {
    throw new ApiKeyFormatError("The API key contains whitespace, a control character, or non-ASCII punctuation. Copy the raw key again without line breaks.");
  }
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(normalized)) {
    throw new ApiKeyFormatError("The API key contains characters that are not valid in a bearer token. Copy the raw key again without formatting.");
  }
  if (normalized.length < 20) {
    throw new ApiKeyFormatError("The API key is unexpectedly short. Copy the complete raw key and retry.");
  }
  return normalized;
}
