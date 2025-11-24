// src/Routers/pvp.js
//
// HTTP API for PVP word selection.
// Swift calls: GET /pvp/word?matchId=...&length=...&lang=en
//
// Success:
//   200 { "value": "apple" }
//
// Error:
//   4xx/5xx { "error": "..." }

const express = require("express");
const router = express.Router();

// ✅ Use your existing Wikipedia-based picker
//    Located at src/Hendlers/Request.js (better-words logic)
const req = require("../Hendlers/Request");

// In-memory cache: matchId -> { ready, value, lang, length, createdAt, promise? }
const pvpWordCache = new Map();

/**
 * This is the only place that actually chooses a word.
 * It uses your existing `getWord(language, length, wordList)` from Request.js.
 *
 * - lang     → "en" / "he"
 * - length   → word length (e.g. 5)
 * - wordList → blocked words (optional, empty for now)
 */
async function pickWordForMatch({ matchId, lang, length }) {
  // Later you can pass a per-match block list if you want:
  // const blocked = [...];
  const blocked = [];
  const value = await req.getWord(lang, length, blocked);

  if (!value || typeof value !== "string") {
    throw new Error("NO_WORD_RETURNED");
  }

  console.log("[PVP] pickWordForMatch", { matchId, lang, length, value });
  return value;
}

/**
 * Get or create the word for a given match.
 * Coalesces concurrent calls for the same matchId.
 * First caller creates the word; later callers reuse it.
 */
async function getOrCreatePvpWord(matchId, lang, length) {
  let entry = pvpWordCache.get(matchId);

  // Already fully resolved
  if (entry && entry.ready) {
    if (entry.lang !== lang || entry.length !== length) {
      // Same matchId but different configuration → explicit conflict
      throw new Error("MATCH_WORD_ALREADY_CREATED_WITH_DIFFERENT_CONFIG");
    }
    return entry.value;
  }

  // In-flight promise → await it
  if (entry && !entry.ready && entry.promise) {
    return entry.promise;
  }

  // Need to create new word via your wiki-based logic
  const promise = (async () => {
    const value = await pickWordForMatch({ matchId, lang, length });

    const finalEntry = {
      ready: true,
      value,
      lang,
      length,
      createdAt: Date.now(),
    };

    pvpWordCache.set(matchId, finalEntry);
    return value;
  })();

  pvpWordCache.set(matchId, {
    ready: false,
    promise,
    lang,
    length,
  });

  return promise;
}

// GET /pvp/word?matchId=...&length=5&lang=en
router.get("/word", async (req, res) => {
  try {
    const { matchId, length, lang } = req.query;

    if (!matchId || !length) {
      return res
        .status(400)
        .json({ error: "matchId and length query params are required" });
    }

    const parsedLength = Number.parseInt(length, 10);
    if (!Number.isFinite(parsedLength) || parsedLength <= 0) {
      return res.status(400).json({ error: "length must be a positive number" });
    }

    const langCode = String(lang || "en").toLowerCase();

    const value = await getOrCreatePvpWord(matchId, langCode, parsedLength);

    return res.json({ value });
  } catch (err) {
    console.error("[PVP] /pvp/word error:", err);

    if (err.message === "MATCH_WORD_ALREADY_CREATED_WITH_DIFFERENT_CONFIG") {
      return res.status(409).json({
        error:
          "Word for this matchId was already created with a different lang/length",
      });
    }

    if (err.message === "NO_WORD_RETURNED") {
      return res.status(500).json({ error: "Word provider returned no word" });
    }

    return res.status(500).json({ error: "no match found" });
  }
});

// Export router as the default export, and expose the cache
// so Socket.IO layer (pvpSocket.js) can clear words when a match ends.
module.exports = router;
module.exports.pvpWordCache = pvpWordCache;
