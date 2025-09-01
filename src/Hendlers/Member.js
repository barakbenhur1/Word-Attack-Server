const moment = require("moment");
const misc = require("../Hendlers/Result");
const Profile = require("../Schemas/Profile/Profile");
const Languages = require("../Schemas/Lanuage/Languages");
const req = require("../Hendlers/Request");

async function get(diffKey, email) {
  const dayKey = moment().format("DD/MM/YYYY");
  const diffcultyKey = misc.cleanText(diffKey);

  const profile = await Profile.findOne({ email: email });
  const languageKey = profile.language;
  let language = await Languages.findOne({ value: languageKey });

  if (!misc.exsit(language)) {
    language = await Languages({ value: languageKey });
    language.save();
    return get(diffcultyKey, email);
  }

  let days = language.days;

  if (days.length == 0) {
    days.push({ value: dayKey, difficulties: [] });
    language.save();
    return get(diffcultyKey, email);
  }

  const day = days[days.length - 1];
  if (day.value != dayKey) {
    days.push({ value: dayKey });
    language.save();
    return get(diffcultyKey, email);
  }

  let difficulties = day.difficulties;

  for (j = 0; j < difficulties.length; j++) {
    const diffculty = difficulties[j];

    if (diffculty.value == diffcultyKey) {
      let members = diffculty.members;

      for (k = 0; k < members.length; k++) {
        const member = members[k];
        if (member.email == email) {
          let words = member.words;

          if (diffculty.words.length == words.length) {
            const length = diffculty.value.includes("Easy")
              ? 4
              : diffculty.value.includes("Medium")
              ? 5
              : 6;

            diffculty.words.push(
              await req.getWord(profile.language, length, words)
            );
            language.save();
            return get(diffcultyKey, email);
          }

          if (words.length == 0 || words[words.length - 1].done) {
            words.push({
              value: diffculty.words[words.length],
              guesswork: [],
              done: false,
            });
            language.save();
            return get(diffcultyKey, email);
          }

          return [member, language];
        }
      }

      members.push({
        email: profile.email,
        name: profile.name,
        totalScore: 0,
        words: [],
      });
      language.save();
      return get(diffcultyKey, email);
    }
  }

  difficulties.push({ value: diffcultyKey, words: [], members: [] });
  language.save();
  return get(diffcultyKey, email);
}

module.exports = { get }