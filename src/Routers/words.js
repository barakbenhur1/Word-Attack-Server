const express = require("express");
const router = express();
const moment = require("moment");
const req = require("../Hendlers/Request");
const result = require("../Hendlers/Result");
const Profile = require("../Schemas/Profile/Profile");
const Languages = require("../Schemas/Lanuage/Languages");

router.post("/word", function (req, res) {
  const email = req.body.email;
  word(email, res);
});

router.post("/getWord", function (req, res) {
  const diffculty = req.body.diffculty;
  const email = req.body.email;
  getWord(diffculty, email, res);
});

router.post("/addGuess", function (req, res) {
  const diffculty = req.body.diffculty;
  const email = req.body.email;
  const guess = req.body.guess;
  addGuess(diffculty, email, guess, res);
});

router.post("/score", function (req, res) {
  const diffculty = req.body.diffculty;
  const email = req.body.email;
  score(diffculty, email, res);
});

router.post("/scoreboard", function (req, res) {
  const email = req.body.email;
  scoreboard(email, res);
});

async function word(email, res) {
  const profile = await Profile.findOne({ email: email });
  let answer = {
    value: await req.getWord(profile.language, 5, false),
  };

  res.send(answer);
}

async function getWord(diffcultyKey, email, res) {
  let member = await getMember(diffcultyKey, email);
  const words = member[0].words;
  const word = words[words.length - 1];
  const answer = {
    score: member[0].totalScore,
    isTimeAttack: words.length % 5 == 0,
    number: words.length - 1,
    word: {
      value: word.value,
      guesswork: word.guesswork,
    },
  };

  res.send(answer);
}

async function addGuess(diffcultyKey, email, guess, res) {
  const member = await getMember(diffcultyKey, email);
  const words = member[0].words;
  const word = words[words.length - 1];
  word.guesswork.push(guess);
  member[1].save();
  res.send({});
}

async function score(diffcultyKey, email, res) {
  const member = await getMember(diffcultyKey, email);
  const words = member[0].words;
  const word = words[words.length - 1];
  const points = words.length % 5 == 0 ? 40 : 20;
  member[0].totalScore += 5 * points - word.guesswork.length * points;
  word.done = true;
  member[1].save();
  res.send({});
}

async function scoreboard(email, res) {
  const profile = await Profile.findOne({ email: email });
  const languageKey = profile.language;
  let language = await Languages.findOne({ value: languageKey });
  res.send(language.days);
}

async function getMember(diffcultyKey, email) {
  const dayKey = moment().format("DD/MM/YYYY");

  const profile = await Profile.findOne({ email: email });
  const languageKey = profile.language;
  let language = await Languages.findOne({ value: languageKey });

  if (!result.exsit(language)) {
    language = await Languages({ value: languageKey });
    language.save();
    return getMember(diffcultyKey, email);
  }

  let days = language.days;

  if (days.length == 0) {
    days.push({ value: dayKey, difficulties: [] });
    language.save();
    return getMember(diffcultyKey, email);
  }

  const day = days[days.length - 1];
  if (day.value != dayKey) {
    days.push({ value: dayKey });
    language.save();
    return getMember(diffcultyKey, email);
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
              await req.getWord(profile.language, length, words.length == 10000)
            );
            language.save();
            return getMember(diffcultyKey, email);
          }

          if (words.length == 0 || words[words.length - 1].done) {
            words.push({
              value: diffculty.words[words.length],
              guesswork: [],
              done: false,
            });
            language.save();
            return getMember(diffcultyKey, email);
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
      return getMember(diffcultyKey, email);
    }
  }

  difficulties.push({ value: diffcultyKey, words: [], members: [] });
  language.save();
  return getMember(diffcultyKey, email);
}

module.exports = router;
