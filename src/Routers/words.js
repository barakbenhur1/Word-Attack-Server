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

async function addGuess(difficultyKey, email, guess, res) {
  try {
    const result = await memberProvider.get(difficultyKey, email);
    const doc = Array.isArray(result) ? result[0] : result; // provider may return [doc, model/parent]
    if (!doc) return res.status(404).send({ error: 'member_not_found' });

    const words = Array.isArray(doc.words) ? doc.words : [];
    if (words.length === 0) return res.status(400).send({ error: 'no_active_word' });

    const idx = words.length - 1;
    const current = words[idx];

    const norm = s => String(s ?? '').trim().toLocaleLowerCase();
    const g = String(guess ?? '').trim();
    if (!g) return res.status(400).send({ error: 'empty_guess' });

    // push guess and mark done (case-insensitive)
    if (!Array.isArray(current.guesswork)) current.guesswork = [];
    current.guesswork.push(g);
    current.done = norm(g) === norm(current.value);

    // Ensure parent document is saved (avoid "saving subdoc doesn't persist" warning)
    if (typeof doc.markModified === 'function') doc.markModified('words');
    await doc.save();

    return res.send({ done: current.done, guesses: current.guesswork.length });
  } catch (err) {
    console.error('addGuess error:', err);
    return res.status(500).send({ error: 'server_error' });
  }
}

module.exports = router;
