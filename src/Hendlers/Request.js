// Import the Axios library for making HTTP requests
const axios = require("axios");
const result = require("./Result");

// Function to fetch a random article title from Wikipedia with language and length options
async function getWord(language, length, wordList) {
  if (language == "en") {
    // return await getEnglishWord(length);
    return await getFromWiki(language, wordList, length);
  } else {
    return await getFromWiki(language, wordList, length);
  }
}

const A_Z  = /^[A-Za-z]+$/;
const HEB  = /^[\u0590-\u05FF]+$/;
const HEB_NIQQUD = /[\u0591-\u05C7]/g;
const HEB_FINALS = { "ך":"כ","ם":"מ","ן":"נ","ף":"פ","ץ":"צ" };

function normalizeHebrew(s) {
  if (!s) return s;
  // remove niqqud
  s = s.replace(HEB_NIQQUD, "");
  // map finals to base forms
  s = s.replace(/[ךםןףץ]/g, ch => HEB_FINALS[ch] || ch);
  return s;
}

function normalizeEnglish(s) {
  return s ? s.toLowerCase() : s;
}

function normalizeWord(s, language) {
  if (!s) return s;
  return language === "he" ? normalizeHebrew(s) : normalizeEnglish(s.toLowerCase());
}

function isLetters(raw, language) {
  return language === "he" ? HEB.test(raw) : A_Z.test(raw);
}

function tokenize(text) {
  // split on non-Hebrew/English letters, drop empties
  return (text || "").split(/[^A-Za-z\u0590-\u05FF]+/).filter(Boolean);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getFromWiki(language, wordList, length, retries = 3) {
  const url = `https://${language}.wikipedia.org/w/api.php`;

  const params = {
    action: "query",
    generator: "random",
    grnlimit: 50,
    grnnamespace: 0,         // mainspace only (no User:, Talk:, etc.)
    prop: "extracts",
    exchars: 500,
    explaintext: 1,
    redirects: 1,
    format: "json",
    origin: "*"
  };

  // Build a normalized blocklist from wordList
  const blocked = new Set(
    Array.isArray(wordList)
      ? wordList
          .map(w => String(w.value))
          .map(w => normalizeWord(w, language))
      : []
  );

  try {
    const { data } = await axios.get(url, { params });
    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];

    const candidates = [];
    for (const page of pages) {
      const titleWords   = tokenize(page.title);
      const extractWords = tokenize(page.extract);
      const combined     = [...titleWords, ...extractWords];

      for (const raw of combined) {
        if (raw.length !== length) continue;
        if (!isLetters(raw, language)) continue;

        const norm = normalizeWord(raw, language);
        if (!blocked.has(norm)) {
          candidates.push(raw); // keep original for display/return
        }
      }
    }

    if (candidates.length > 0) {
      return pickRandom(candidates);
    }

    if (retries > 0) {
      return getFromWiki(language, wordList, length, retries - 1);
    }

    throw new Error("No suitable word found after multiple attempts.");
  } catch (err) {
    throw err;
  }
}

async function getEnglishWord(length) {
  const options = {
    method: "GET",
    url: "https://word-generator2.p.rapidapi.com/",
    params: { length: length },
    headers: {
      "x-rapidapi-key": "8d3836a577mshcb3b08ace209963p1056f4jsnec07b98e10ce",
      "x-rapidapi-host": "word-generator2.p.rapidapi.com",
    },
  };
  try {
    const response = await axios.request(options);
    const wordList = response.data.body;

    if (wordList.length === 0) {
      return `No English words found with length ${length}.`;
    }
    return wordList[Math.floor(Math.random() * wordList.length)];
  } catch (error) {
    return console.error("Error fetching word:", error);
  }
}

function isHebrew(str) {
  const hebrewRegex = /^[\u0590-\u05FF\s]+$/; // Hebrew character range and whitespace allowed
  return hebrewRegex.test(str);
}

function isEnglish(text) {
  // Regular expression to match only English letters (both uppercase and lowercase) and spaces
  const englishRegex = /^[A-Za-z\s]+$/;
  return englishRegex.test(text);
}

async function isWordInLanguage(word, language) {
  if (language == "he") {
    try {
      const url = `https://he.wiktionary.org/w/api.php?action=query&titles=${word}&prop=extracts&format=json&explaintext`;
      const response = await axios.get(url);

      const pages = response.data.query.pages;
      const page = Object.values(pages)[0];

      // If there is an extract, the word exists
      return page.extract ? true : false;
    } catch (error) {
      console.error("Error:", error.message);
      return false; // Word does not exist
    }
  } else {
    try {
      // Replace with the actual dictionary API URL (Wordnik, Oxford, etc.)
      const url = `https://api.dictionaryapi.dev/api/v2/entries/${language}/${word}`;

      // Make API request
      const response = await axios.get(url);

      // If a definition is found, the word exists in the language
      if (response.data.length > 0) {
        return true; // Word exists
      }
    } catch (error) {
      // If the word doesn't exist or there's an error, return false
      console.error(
        "Error or word not found:",
        error.response?.statusText || error.message
      );
      return false;
    }

    return false;
  }
}

module.exports = { getWord };
