// better-words.js
const axios = require("axios");

// ===================== Language utils ======================
const A_Z = /^[A-Za-z]+$/;
const HEB = /^[\u0590-\u05FF]+$/;
const HEB_NIQQUD = /[\u0591-\u05C7]/g;
const HEB_FINALS = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
const ROMAN_NUM =
  /^(?=[IVXLCDM]+$)M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;
const HEB_GERESH = /[\u05F3\u05F4]/; // ׳ ״
const HEB_MAQAF = /\u05BE/; // ־

function normalizeHebrew(s) {
  if (!s) return s;
  s = s.replace(HEB_NIQQUD, ""); // strip niqqud
  s = s.replace(/[ךםןףץ]/g, (ch) => HEB_FINALS[ch] || ch); // finals → base
  return s;
}
function normalizeEnglish(s) {
  return s ? s.toLowerCase() : s;
}

function normalizeWord(s, language) {
  if (!s) return s;
  return language === "he" ? normalizeHebrew(s) : normalizeEnglish(s);
}
function isLetters(raw, language) {
  return language === "he" ? HEB.test(raw) : A_Z.test(raw);
}
function tokenize(text) {
  // split on non letters; keep only Hebrew/English tokens
  return (text || "").split(/[^A-Za-z\u0590-\u05FF]+/).filter(Boolean);
}

// -------- Hebrew-specific helpers (block odd forms) --------
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Feminine-construct tokens like "משפחת" used as “X of Y” in running text.
function appearsAsConstruct(raw, haystack) {
  if (!raw.endsWith("ת")) return false;
  // raw followed by whitespace + Hebrew letter (likely “X of Y”)
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(raw)}\\s+[\\u0590-\\u05FF]`);
  return re.test(haystack);
}

// Reflexive “self” forms (בעצמי/בעצמך/בעצמו/בעצמה/בעצמנו/בעצמכם/בעצמכן/בעצמם/בעצמן)
function isReflexiveSelf(raw) {
  return /^בעצמ(?:י|ך|ךְ|ו|ה|נו|כם|כן|ם|ן)$/.test(raw);
}

// If word starts with clitic (ב/ל/מ/כ) and base appears in extract, prefer base (reject clitic form).
function hasCliticWithSeenBase(raw, freqMap, language) {
  if (language !== "he") return false;
  if (!/^[בלמכ]/.test(raw)) return false;
  const base = normalizeHebrew(raw.slice(1));
  return base.length >= 2 && freqMap.has(base);
}

// ===================== Public API ======================
async function getWord(language, length, wordList = []) {
  return await getFromWiki(language, length, wordList);
}

module.exports = { getWord };

// ===================== Wikipedia picker ======================
// Put this near your imports:
const WIKI_UA =
  "WordZapBot/1.0 (+https://word-attack.onrender.com; contact: support@wordzap.app)"; // <-- use your real URL/contact

// Helper: axios instance with proper headers
const axiosWiki = axios.create({
  timeout: 8000,
  headers: {
    "User-Agent": WIKI_UA,
    "Api-User-Agent": WIKI_UA,
    Accept: "application/json",
  },
  decompress: true,
});

// Optional: REST fallback to avoid 403s or generator hiccups
async function fetchRandomSummariesREST(lang, count = 20) {
  const endpoint = `https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`;
  const reqs = Array.from({ length: count }, () =>
    axiosWiki
      .get(endpoint, { validateStatus: (s) => s === 200 })
      .then((r) => r.data)
      .catch(() => null)
  );
  const items = (await Promise.all(reqs)).filter(Boolean);
  // Adapt shape to what collectCandidates expects (title/extract/categories)
  return items.map((d) => ({
    title: d.title,
    extract: d.extract || "",
    categories: [], // REST summary doesn't include categories
  }));
}

async function getFromWiki(language, length, wordList, maxAttempts = 8) {
  const url = `https://${language}.wikipedia.org/w/api.php`;
  const params = {
    action: "query",
    generator: "random",
    grnlimit: 50,            // try 50 pages per attempt
    grnnamespace: 0,         // mainspace
    grnfilterredir: "nonredirects",
    prop: "extracts|categories",
    cllimit: 50,
    clshow: "!hidden",
    exchars: 1200,
    explaintext: 1,          // (typo safeguard; will set explaint**p**laintext below)
    redirects: 1,
    format: "json",
    formatversion: 2,        // cleaner arrays
    // origin: "*",          // ❌ for browsers only; remove server-side to avoid 403
  };

  // Ensure plaintext + get extracts for all generated pages
  params.explaintext = 1;
  params.exlimit = params.grnlimit;

  // Normalize blocklist (your original logic)
  const blocked = new Set(
    Array.isArray(wordList) && wordList.length > 0
      ? wordList
          .map((w) => (typeof w === "string" ? w : String(w.value)))
          .map((w) => normalizeWord(w, language))
      : []
  );

  // Attempt loop
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let pages = [];

    // 1) Try Action API
    try {
      const res = await axiosWiki.get(url, {
        params,
        validateStatus: () => true, // we'll handle status codes
      });

      if (res.status === 200 && res.data?.query?.pages) {
        pages = Array.isArray(res.data.query.pages)
          ? res.data.query.pages
          : Object.values(res.data.query.pages);
      } else if (res.status === 403) {
        console.warn(
          `[Wiki] attempt ${attempt + 1} got 403 (likely UA/origin/rate). Falling back to REST.`
        );
      } else {
        console.warn(
          `[Wiki] attempt ${attempt + 1} unexpected status ${res.status}`
        );
      }
    } catch (e) {
      console.warn(`[Wiki] attempt ${attempt + 1} failed:`, e?.message || e);
    }

    // 2) If Action API yielded nothing, try REST fallback (20 summaries)
    if (!pages.length) {
      const restPages = await fetchRandomSummariesREST(language, 20);
      if (restPages.length) {
        pages = restPages;
      }
    }

    if (!pages.length) {
      // Light backoff and (optionally) make the next generator request smaller
      await new Promise((r) => setTimeout(r, 250 + attempt * 150));
      if (params.grnlimit > 20) {
        params.grnlimit = 20;
        params.exlimit = 20;
      }
      continue; // next attempt
    }
    
    const candidates = collectCandidates(pages, language, length, blocked);
    if (candidates.length) {
      // Weighted pick by quality score (your logic)
      const total = candidates.reduce((s, c) => s + c.score, 0);
      let r = Math.random() * total;
      for (const c of candidates) {
        r -= c.score;
        if (r <= 0) return c.raw; // keep original casing for display
      }
      return candidates[candidates.length - 1].raw;
    }

    // otherwise retry with fresh random pages
  }

  throw new Error("No suitable word found after multiple attempts.");
}

// ===================== Candidate collection & scoring ======================
function collectCandidates(pages, language, length, blocked) {
  const out = [];
  for (const page of pages) {
    const title = page.title || "";
    const extract = page.extract || "";
    const lead = extract.slice(0, 200);
    const titleTokens = tokenize(title);
    const extractTokens = tokenize(extract);
    if (!titleTokens.length && !extractTokens.length) continue;

    // Page-level signals (used to detect transliterations/proper names on HE)
    const hasLatinInLead = /[A-Za-z]/.test(lead);
    const hasLatinInTitle = /[A-Za-z]/.test(title);
    const parenLatinLead = /\([^)]+[A-Za-z][^)]+\)/.test(lead);
    const parenLatinTitle = /\([^)]+[A-Za-z][^)]+\)/.test(title);
    const categories = Array.isArray(page.categories)
      ? page.categories.map((c) => c.title || "")
      : [];
    const catStr = categories.join(" | ");

    const isProperNamePageHe =
      /קטגוריה:(שם פרטי|שמות פרטיים|שם משפחה|שמות משפחה|אישים|ספורטאים|שחקנים|זמרים|זמרות|סופרים|מדינאים|דמויות בדיוניות)/.test(
        catStr
      );

    // Build frequency map from extract (normalized) → occurrences
    const freqMap = new Map();
    for (const tok of extractTokens) {
      const n = normalizeWord(tok, language);
      if (!n) continue;
      freqMap.set(n, (freqMap.get(n) || 0) + 1);
    }

    const combined = [...titleTokens, ...extractTokens];
    for (const raw of combined) {
      if (!isLetters(raw, language)) continue;

      const norm = normalizeWord(raw, language);
      if (!norm || norm.length !== length) continue;
      if (blocked.has(norm)) continue;

      const inTitle = titleTokens.some(
        (t) => normalizeWord(t, language) === norm
      );
      const countInExtract = freqMap.get(norm) || 0;

      // Quality gates
      if (
        !passesHeuristics({
          raw,
          norm,
          lang: language,
          inTitle,
          countInExtract,
          hasLatinInLead,
          hasLatinInTitle,
          parenLatinLead,
          parenLatinTitle,
          isProperNamePageHe,
          extract,
          freqMap,
        })
      )
        continue;

      const score = qualityScore({
        raw,
        norm,
        language,
        inTitle,
        countInExtract,
      });
      if (score > 0) out.push({ raw, norm, score });
    }
  }

  // Deduplicate by normalized form (keep best score)
  const best = new Map();
  for (const c of out) {
    const prev = best.get(c.norm);
    if (!prev || c.score > prev.score) best.set(c.norm, c);
  }
  return [...best.values()];
}

function passesHeuristics(ctx) {
  const {
    raw,
    norm,
    lang,
    inTitle,
    countInExtract,
    hasLatinInLead,
    hasLatinInTitle,
    parenLatinLead,
    parenLatinTitle,
    isProperNamePageHe,
    extract,
    freqMap,
  } = ctx;

  // Common rejects
  if (norm.length <= 1) return false;
  if (ROMAN_NUM.test(raw)) return false;
  if (/[’'\-]/.test(raw)) return false; // hyphen/quote-y tokens
  if (/(.)\1\1/.test(norm)) return false; // triple repeats
  if (/\d/.test(raw)) return false; // numbers inside token

  if (lang === "en") {
    // Avoid acronyms / ALLCAPS; avoid TitleCase proper nouns
    if (/^[A-Z]{2,}$/.test(raw)) return false;
    if (/^[A-Z][a-z]+$/.test(raw)) return false;
    // Avoid very weird mixes
    if (/[zxjq]{2,}/i.test(raw)) return false;
    // Must appear in extract at least once (not only in title)
    if (countInExtract === 0) return false;
    return true;
  } else {
    // Hebrew: reject abbreviations/transliterations/proper-name patterns
    if (HEB_GERESH.test(raw)) return false; // ׳/״
    if (HEB_MAQAF.test(raw)) return false; // ־
    // finals should be at end only
    if (/[ךםןףץ](?=.)/.test(raw)) return false;

    // No reflexive “self” forms (e.g., בעצמו, בעצמה...)
    if (isReflexiveSelf(raw)) return false;

    // No feminine construct used as X-of-Y (e.g., "משפחת ...")
    if (appearsAsConstruct(raw, extract)) return false;

    // No clitic+base when base also exists in extract (e.g., בגינה if גינה appears)
    if (hasCliticWithSeenBase(raw, freqMap, lang)) return false;

    // Transliteration/proper-name vibes from page context
    if (
      inTitle &&
      (hasLatinInTitle || parenLatinTitle || hasLatinInLead || parenLatinLead)
    ) {
      return false;
    }

    // Person/name-heavy page? be stricter
    if (isProperNamePageHe && countInExtract < 2) return false;

    // Require presence in extract
    if (countInExtract === 0) return false;

    return true;
  }
}

function qualityScore({ raw, norm, language, inTitle, countInExtract }) {
  // Base from frequency in extract (proxy for topicality & commonness)
  let score = 1 + Math.min(countInExtract, 4); // cap to avoid dominance

  // Title presence boosts (proper nouns mostly filtered already)
  if (inTitle) {
    if (language === "en" && /^[A-Z]/.test(raw)) score += 0.5;
    else score += 0.8;
  }

  // Language-specific tweaks
  if (language === "en") {
    if (/^[a-z]+$/.test(raw)) score += 0.3; // natural lowercase
    if (/[qzjx]{2,}/i.test(raw)) score -= 0.4;
  } else {
    // Hebrew: small bonus for “core” forms (no finals in display token)
    if (!/[ךםןףץ]/.test(raw)) score += 0.2;
  }

  return Math.max(0.1, score);
}
