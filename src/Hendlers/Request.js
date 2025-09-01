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

async function getFromWiki(language, wordList, length) {
  const url = `https://${language}.wikipedia.org/w/api.php`;

  const params = {
    action: "query",
    list: "random",
    rnlimit: 5,
    format: "json",
    prop: "extracts",
    exchars: 500,
    explaintext: true,
  };

  try {
    const { data } = await axios.get(url, { params });
    const articles = data.query.random;

    for (let article of articles) {
      const titleWords = article.title.split(" ");
      const extractWords = (article.extract || "").split(" ");

      const combinedWords = [...titleWords, ...extractWords];
      const word = combinedWords.find(
        (w) =>
          w.length === length && 
          (!Array.isArray(wordList) || 
          !wordList.some(v => v.value === w)) && 
          (language == "en" ? isEnglish(w) : isHebrew(w))
      );

      if (result.exsit(word) && (await isWordInLanguage(word, language)))
        return word;
    }
    return getFromWiki(language, length);
  } catch (error) { return error; }
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
