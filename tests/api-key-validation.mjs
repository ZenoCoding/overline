import assert from "node:assert/strict";
import { ApiKeyFormatError, normalizeApiKey } from "../scripts/api-key.mjs";

const projectKey = "sk-proj-dummy_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const serviceKey = "sk-svcacct-dummy_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

assert.equal(normalizeApiKey(` \t\r\n${projectKey}\r\n `), projectKey);
assert.equal(normalizeApiKey(serviceKey), serviceKey);
assert.throws(() => normalizeApiKey(`sk-proj-dummy_ABC\rDEF01234567890123456789`), ApiKeyFormatError);
assert.throws(() => normalizeApiKey(`sk-proj-dummy_ABC\nDEF01234567890123456789`), ApiKeyFormatError);
assert.throws(() => normalizeApiKey(`“${projectKey}”`), ApiKeyFormatError);
assert.throws(() => normalizeApiKey(`"${projectKey}"`), ApiKeyFormatError);
assert.throws(() => normalizeApiKey("short"), ApiKeyFormatError);

console.log("API-key normalization: PASS (surrounding paste whitespace normalized; embedded invalid characters rejected; no network call). ");
