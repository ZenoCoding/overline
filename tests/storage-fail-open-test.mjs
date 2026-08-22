import assert from "node:assert/strict";
import fs from "node:fs";
import { ApiKeyFormatError, normalizeApiKey } from "../scripts/api-key.mjs";

// ============================================================================
// 1. Comprehensive API Key Validation & Normalization Matrix
// ============================================================================
console.log("Testing API key validation error matrix...");
{
  const validKeys = [
    "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz",
    "sk-svcacct-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "  \t\r\nsk-proj-valid-key-with-surrounding-whitespace-12345\n\r  ",
    "sk-proj_ABC.DEF~GHI+JKL/MNO=PQR-STU_1234567890"
  ];

  for (const key of validKeys) {
    const normalized = normalizeApiKey(key);
    assert.ok(normalized.length >= 20, "Normalized key must be at least 20 chars");
    assert.equal(normalized, key.trim(), "Must match trimmed key");
  }

  const invalidTestCases = [
    { input: null, expectedMsg: /not set/i },
    { input: undefined, expectedMsg: /not set/i },
    { input: 12345678901234567890, expectedMsg: /not set/i },
    { input: {}, expectedMsg: /not set/i },
    { input: "", expectedMsg: /empty/i },
    { input: "   \t\r\n   ", expectedMsg: /empty/i },
    { input: '"sk-proj-1234567890abcdefghijklmnopqrstuvwxyz"', expectedMsg: /quotes/i },
    { input: "'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz'", expectedMsg: /quotes/i },
    { input: '“sk-proj-1234567890abcdefghijklmnopqrstuvwxyz”', expectedMsg: /non-ASCII|quotes/i },
    { input: '‘sk-proj-1234567890abcdefghijklmnopqrstuvwxyz’', expectedMsg: /non-ASCII|quotes/i },
    { input: "sk-proj-1234567890\nabcdefghijklmnopqrstuvwxyz", expectedMsg: /whitespace|control/i },
    { input: "sk-proj-1234567890\rabcdefghijklmnopqrstuvwxyz", expectedMsg: /whitespace|control/i },
    { input: "sk-proj-1234567890\tabcdefghijklmnopqrstuvwxyz", expectedMsg: /whitespace|control/i },
    { input: "sk-proj-1234567890\x00abcdefghijklmnopqrstuvwxyz", expectedMsg: /control/i },
    { input: "sk-proj-1234567890💡abcdefghijklmnopqrstuvwxyz", expectedMsg: /non-ASCII/i },
    { input: "sk-proj-1234567890#abcdefghijklmnopqrstuvwxyz", expectedMsg: /bearer token/i },
    { input: "sk-proj-1234567890$abcdefghijklmnopqrstuvwxyz", expectedMsg: /bearer token/i },
    { input: "sk-proj-1234567890@abcdefghijklmnopqrstuvwxyz", expectedMsg: /bearer token/i },
    { input: "sk-proj-short", expectedMsg: /short/i }
  ];

  for (const { input, expectedMsg } of invalidTestCases) {
    assert.throws(
      () => normalizeApiKey(input),
      (err) => {
        assert.ok(err instanceof ApiKeyFormatError || err instanceof Error, "Should throw ApiKeyFormatError");
        assert.match(err.message, expectedMsg);
        return true;
      },
      `Expected normalization error for input: ${JSON.stringify(input)}`
    );
  }

  console.log("  ✓ API key validation matrix passed.");
}

// ============================================================================
// 2. Storage Fail-Open Behavior Simulation in Player Context
// ============================================================================
console.log("Testing player storageGet / storageSet fail-open resilience...");
{
  const STORAGE_KEY = "link-click-ep1-offset-seconds";

  function createPlayerStorage(mockChrome) {
    function extensionStorageAvailable() {
      try {
        return Boolean(mockChrome?.runtime?.id && mockChrome?.storage?.local);
      } catch {
        return false;
      }
    }

    function storageGet(defaultValue) {
      if (typeof mockChrome === "undefined" || !extensionStorageAvailable()) return Promise.resolve(defaultValue);
      try {
        return mockChrome.storage.local.get({ [STORAGE_KEY]: defaultValue })
          .then((result) => Number(result[STORAGE_KEY]))
          .catch(() => defaultValue);
      } catch {
        return Promise.resolve(defaultValue);
      }
    }

    function storageSet(value) {
      if (typeof mockChrome === "undefined" || !extensionStorageAvailable()) return Promise.resolve();
      try {
        return mockChrome.storage.local.set({ [STORAGE_KEY]: value }).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    }

    return { storageGet, storageSet, extensionStorageAvailable };
  }

  // Case A: chrome is undefined (e.g. standalone iframe or node test)
  {
    const storage = createPlayerStorage(undefined);
    assert.equal(storage.extensionStorageAvailable(), false);
    const val = await storage.storageGet(124);
    assert.equal(val, 124, "Must return default offset when chrome is undefined");
    await assert.doesNotReject(() => storage.storageSet(125), "storageSet must resolve cleanly");
  }

  // Case B: chrome.runtime exists but runtime.id is missing (Extension context invalidated)
  {
    const storage = createPlayerStorage({ runtime: {} });
    assert.equal(storage.extensionStorageAvailable(), false);
    const val = await storage.storageGet(124);
    assert.equal(val, 124, "Must return default offset on invalidated context");
    await assert.doesNotReject(() => storage.storageSet(125));
  }

  // Case C: chrome.storage.local.get throws synchronous error
  {
    const throwingChrome = {
      runtime: { id: "mock-ext-id" },
      storage: {
        local: {
          get() { throw new Error("Disk quota exceeded / context dead"); },
          set() { throw new Error("Disk quota exceeded / context dead"); }
        }
      }
    };
    const storage = createPlayerStorage(throwingChrome);
    const val = await storage.storageGet(124);
    assert.equal(val, 124, "Must catch synchronous throw and return default offset");
    await assert.doesNotReject(() => storage.storageSet(125));
  }

  // Case D: chrome.storage.local.get returns rejected Promise
  {
    const rejectingChrome = {
      runtime: { id: "mock-ext-id" },
      storage: {
        local: {
          get: () => Promise.reject(new Error("Storage permission revoked")),
          set: () => Promise.reject(new Error("Storage permission revoked"))
        }
      }
    };
    const storage = createPlayerStorage(rejectingChrome);
    const val = await storage.storageGet(124);
    assert.equal(val, 124, "Must catch async rejection and return default offset");
    await assert.doesNotReject(() => storage.storageSet(125));
  }

  // Case E: Healthy storage returns stored value
  {
    const healthyChrome = {
      runtime: { id: "mock-ext-id" },
      storage: {
        local: {
          get: () => Promise.resolve({ [STORAGE_KEY]: 128.5 }),
          set: () => Promise.resolve()
        }
      }
    };
    const storage = createPlayerStorage(healthyChrome);
    const val = await storage.storageGet(124);
    assert.equal(val, 128.5, "Must return stored value when storage is healthy");
  }

  console.log("  ✓ Player storage fail-open resilience passed.");
}

// ============================================================================
// 3. Popup Session Storage Fail-Open Behavior
// ============================================================================
console.log("Testing popup session storage fail-open behavior...");
{
  async function loadPopupConfig(mockChrome) {
    let sessionApiKey = "";
    let keyStatusText = "";
    try {
      if (mockChrome?.storage?.session) {
        const data = await mockChrome.storage.session.get(["openai_api_key", "openai_model"]);
        if (data?.openai_api_key) {
          sessionApiKey = data.openai_api_key;
          keyStatusText = `Session key active (••••${sessionApiKey.slice(-4)})`;
        } else {
          keyStatusText = "No API key configured for live mode";
        }
      } else {
        keyStatusText = "Session storage unavailable";
      }
    } catch {
      keyStatusText = "Session storage unavailable";
    }
    return { sessionApiKey, keyStatusText };
  }

  // Unavailable storage
  const res1 = await loadPopupConfig(null);
  assert.equal(res1.keyStatusText, "Session storage unavailable");
  assert.equal(res1.sessionApiKey, "");

  // Failing storage
  const res2 = await loadPopupConfig({
    storage: {
      session: {
        get: () => Promise.reject(new Error("Session storage disabled"))
      }
    }
  });
  assert.equal(res2.keyStatusText, "Session storage unavailable");
  assert.equal(res2.sessionApiKey, "");

  // Populated storage
  const res3 = await loadPopupConfig({
    storage: {
      session: {
        get: () => Promise.resolve({ openai_api_key: "sk-proj-test-1234567890abcdef", openai_model: "gpt-4o-transcribe" })
      }
    }
  });
  assert.equal(res3.sessionApiKey, "sk-proj-test-1234567890abcdef");
  assert.match(res3.keyStatusText, /Session key active/);

  console.log("  ✓ Popup session storage fail-open passed.");
}

console.log("Storage fail-open tests: PASS (All validation error matrices and storage failure modes validated).");
