const express = require("express");
const router = express();
const req = require("../Hendlers/Request");
const { sendSilentPushToAllUsers } = require("../Utils/apns");
const Profile = require("../Schemas/Profile/Profile");
const memberProvider = require("../Hendlers/Member");

router.post("/word", function (req, res) {
  const uniqe = req.body.uniqe;
  word(uniqe, res);
});

router.post("/getWord", function (req, res) {
  const diffculty = req.body.diffculty;
  const uniqe = req.body.uniqe;
  getWord(diffculty, uniqe, res);
});

router.post("/addGuess", function (req, res) {
  const diffculty = req.body.diffculty;
  const uniqe = req.body.uniqe;
  const guess = req.body.guess;
  addGuess(diffculty, uniqe, guess, res);
});

async function word(uniqe, res) {
  const profile = await Profile.findOne({ uniqe: uniqe });
  const word = await req.getWord(profile.language, 5);
  let answer = {
    value: word,
  };

  await sendSilentPushToAllUsers({
    type: "wordzap.refresh",
    args: { reason: "leaderboard_update" },
  });

  res.send(answer);
}

async function getWord(diffcultyKey, uniqe, res) {
  let member = await memberProvider.get(diffcultyKey, uniqe);
  const words = member[0].words;
  const word = words[words.length - 1];
  const answer = {
    isTimeAttack: words.length % 5 == 0,
    number: words.length - 1,
    word: {
      value: word.value,
      guesswork: word.guesswork,
    },
  };

  res.send(answer);
}

async function addGuess(diffcultyKey, uniqe, guess, res) {
  const member = await memberProvider.get(diffcultyKey, uniqe, false);
  const words = member[0].words;
  const word = words[words.length - 1];
  word.guesswork.push(guess);
  word.done = word.guesswork.length === 5 || guess.toLocaleLowerCase() === word.value.toLocaleLowerCase();
  await member[1].save();
  res.send({});
}

module.exports = router;
