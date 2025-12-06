const moment = require("moment");
const misc = require("../Hendlers/Result");
const Profile = require("../Schemas/Profile/Profile");
const Languages = require("../Schemas/Lanuage/Languages");
const req = require("../Hendlers/Request");

// ---- Helpers --------------------------------------------------------------

function ensureArray(val) {
  return Array.isArray(val) ? val : [];
}

// ---- Main APIs ------------------------------------------------------------

async function get(diffKey, uniqe, modify = true) {
  const dayKey = moment().format("DD/MM/YYYY");
  const difficultyKey = misc.cleanText(diffKey);

  // Only fetch what we need from Profile
  const profile = await Profile.findOne(
    { uniqe },
    { language: 1, uniqe: 1, name: 1 }
  ).lean();

  if (!profile) {
    // If you prefer, throw instead of returning null
    return null;
  }

  // Load language doc once (no recursion)
  let language = await Languages.findOne(
    { value: profile.language },
    { days: 1, value: 1 }
  );

  if (!language) {
    language = new Languages({
      value: profile.language,
      days: [],
    });
  }

  // --- Ensure "today" day exists ------------------------------------------

  language.days = ensureArray(language.days);

  let day = language.days[language.days.length - 1];

  if (!day || day.value !== dayKey) {
    day = { value: dayKey, difficulties: [] };
    language.days.push(day);
  }

  day.difficulties = ensureArray(day.difficulties);

  // --- Ensure difficulty exists -------------------------------------------

  let difficulty =
    day.difficulties.find((d) => d.value === difficultyKey) || null;

  if (!difficulty) {
    difficulty = { value: difficultyKey, words: [], members: [] };
    day.difficulties.push(difficulty);
  }

  difficulty.words = ensureArray(difficulty.words);
  difficulty.members = ensureArray(difficulty.members);

  // --- Ensure member exists -----------------------------------------------

  let member = difficulty.members.find((m) => m.uniqe === uniqe) || null;

  if (!member) {
    member = {
      uniqe: profile.uniqe,
      name: profile.name,
      totalScore: 0,
      words: [],
    };
    difficulty.members.push(member);
  }

  member.words = ensureArray(member.words);

  const words = member.words;
  const difficultyWords = difficulty.words;

  // --- If we've used all difficulty words for this member, generate a new one

  if (modify) {
    if (difficultyWords.length === words.length) {
      const length = difficulty.value.includes("Easy")
        ? 4
        : difficulty.value.includes("Medium")
        ? 5
        : 6;

      // This is likely the slow part (external request),
      // but we only call it *once* now, not via recursion.
      const word = await req.getWord(profile.language, length, words);
      difficultyWords.push(word);
    }
  }

  // --- Ensure there's an active word for this member ----------------------

  if (words.length === 0 || words[words.length - 1].done) {
    const nextIndex = words.length;
    const baseWord = difficultyWords[nextIndex];

    if (baseWord) {
      words.push({
        value: baseWord,
        guesswork: [],
        done: false,
      });
    }
  }

  // Only one save at the end
  if (language.isModified && language.isModified()) {
    await language.save();
  } else if (language.isNew) {
    await language.save();
  }

  return [member, language];
}

async function getPremium(uniqe) {
  const profile = await Profile.findOne(
    { uniqe },
    { language: 1, uniqe: 1, name: 1 }
  ).lean();

  if (!profile) {
    return null;
  }

  let language = await Languages.findOne(
    { value: profile.language },
    { premium: 1, value: 1 }
  );

  if (!language) {
    language = new Languages({
      value: profile.language,
      premium: [],
    });
  }

  language.premium = ensureArray(language.premium);

  let member = language.premium.find((m) => m.uniqe === uniqe) || null;

  if (!member) {
    member = {
      uniqe: profile.uniqe,
      name: profile.name,
    };
    language.premium.push(member);
    await language.save();
  }

  return [member, language];
}

module.exports = { get, getPremium };
