function wrap(body) {
   return {
        value: body,
      };
}

function exsit(prameter) {
  return prameter !== null && prameter !== undefined;
}

function cleanText(input) {
  if (!input) return "";

  // 1. Remove emoji and symbols outside basic multilingual plane
  // (covers most emojis)
  const noEmojis = input.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");

  // 2. Collapse multiple spaces into one, and trim
  return noEmojis.replace(/\s+/g, " ").trim();
}

module.exports = { wrap, exsit, cleanText }