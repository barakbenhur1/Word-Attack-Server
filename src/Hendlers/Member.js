const moment = require("moment");
const misc = require("../Hendlers/Result");
const Profile = require("../Schemas/Profile/Profile");
const Languages = require("../Schemas/Lanuage/Languages");
const req = require("../Hendlers/Request");

async function get(diffKey, uniqe) {
  const dayKey = moment().format("DD/MM/YYYY");
  const diffcultyKey = misc.cleanText(diffKey);

  const profile = await Profile.findOne({ uniqe: uniqe });
  const languageKey = profile.language;
  let language = await Languages.findOne({ value: languageKey }, { days: 1 });

  if (!misc.exsit(language)) {
    language = await Languages({ value: languageKey });
    language.save();
    return get(diffcultyKey, uniqe);
  }

  let days = language.days;

  if (days.length == 0) {
    days.push({ value: dayKey, difficulties: [] });
    language.save();
    return get(diffcultyKey, uniqe);
  }

  const day = days[days.length - 1];
  if (day.value != dayKey) {
    days.push({ value: dayKey });
    language.save();
    return get(diffcultyKey, uniqe);
  }

  let difficulties = day.difficulties;

  for (j = 0; j < difficulties.length; j++) {
    const diffculty = difficulties[j];

    if (diffculty.value == diffcultyKey) {
      let members = diffculty.members;

      for (k = 0; k < members.length; k++) {
        const member = members[k];
        if (member.uniqe == uniqe) {
          let words = member.words;

          if (diffculty.words.length == words.length) {
            const length = diffculty.value.includes("Easy")
              ? 4
              : diffculty.value.includes("Medium")
              ? 5
              : 6;

            const word = await req.getWord(profile.language, length, words);
            diffculty.words.push(word);
            language.save();
            return get(diffcultyKey, uniqe);
          }

          if (words.length == 0 || words[words.length - 1].done) {
            words.push({
              value: diffculty.words[words.length],
              guesswork: [],
              done: false,
            });
            language.save();
            return get(diffcultyKey, uniqe);
          }

          return [member, language];
        }
      }

      members.push({
        uniqe: profile.uniqe,
        name: profile.name,
        totalScore: 0,
        words: [],
      });
      language.save();
      return get(diffcultyKey, uniqe);
    }
  }

  difficulties.push({ value: diffcultyKey, words: [], members: [] });
  language.save();
  return get(diffcultyKey, uniqe);
}

async function getPremium(uniqe) {
  const profile = await Profile.findOne({ uniqe: uniqe });
  const languageKey = profile.language;
  let language = await Languages.findOne(
    { value: languageKey },
    { premium: 1 }
  );

  if (!misc.exsit(language)) {
    language = await Languages({ value: languageKey });
    language.save();
    return getPremium(uniqe);
  }

  if (language.premium.length == 0) {
    language.premium.push({
      uniqe: profile.uniqe,
      name: profile.name,
    });

    language.save();
    return getPremium(uniqe);
  }

  let premiumMembers = language.premium;
  for (j = 0; j < premiumMembers.length; j++) {
    const member = premiumMembers[j];
    if (member.uniqe == uniqe) {
      return [member, language];
    }
  }

  return null;
}

module.exports = { get, getPremium };
