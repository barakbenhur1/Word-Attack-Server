const express = require("express");
const router = express();
const req = require("../Hendlers/Request");
const { sendSilentPushToAllUsers } = require("../Utils/apns");
const Profile = require("../Schemas/Profile/Profile");
const memberProvider = require("../Hendlers/Member");

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

async function word(email, res) {
  const profile = await Profile.findOne({ email: email });
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

async function getWord(diffcultyKey, email, res) {
  let member = await memberProvider.get(diffcultyKey, email);
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

async function addGuess(diffcultyKey, email, guess, res) {
  const member = await memberProvider.get(diffcultyKey, email);
  const words = member[0].words;
  const word = words[words.length - 1];
  word.guesswork.push(guess);
  member[1].save();
  res.send({});
}

module.exports = router;
