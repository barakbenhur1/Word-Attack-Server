const express = require("express");
const router = express();
const Profile = require("../Schemas/Profile/Profile");
const Languages = require("../Schemas/Lanuage/Languages");
const memberProvider = require("../Hendlers/Member");

router.post("/score", function (req, res) {
  const diffculty = req.body.diffculty;
  const email = req.body.email;
  score(diffculty, email, res);
});

router.post("/scoreboard", function (req, res) {
  const email = req.body.email;
  scoreboard(email, res);
});

router.post("/place", function (req, res) {
  const email = req.body.email;
  place(email, res);
});

async function getDaysForUser(email) {
  const profile = await Profile.findOne({ email });
  if (!profile) return [];

  const language = await Languages.findOne({ value: profile.language });
  return language?.days ?? [];
}

async function scoreboard(email, res) {
  const days = await getDaysForUser(email);
  res.send(days);
}

async function score(diffcultyKey, email, res) {
  const member = await memberProvider.get(diffcultyKey, email);
  const words = member[0].words;
  const word = words[words.length - 1];
  const points = words.length % 5 == 0 ? 40 : 20;
  member[0].totalScore += 5 * points - word.guesswork.length * points;
  word.done = true;
  member[1].save();
  res.send({});
}

async function place(email, res) {
  try {
    const days = await getDaysForUser(email);
    if (!days.length) { return res.status(404).send({ easy: null, medium: null, hard: null });  }

    // pick the last day (assuming array is ordered chronologically)
    const lastDay = days[days.length - 1];
    const difficulties = Array.isArray(lastDay.difficulties) ? lastDay.difficulties : [];

    const result = { easy: null, medium: null, hard: null };

    for (const diff of difficulties) {
      const key = String(diff.value || "").toLowerCase();
      const members = Array.isArray(diff.members) ? diff.members : [];

      const sorted = [...members].sort(
        (a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0)
      );

      const idx = sorted.findIndex(
        (m) => String(m.email || "").toLowerCase() === String(email).toLowerCase()
      );

      if (idx >= 0) {
        result[cleanText(key)] = idx + 1; // 1-based place
      }
    }

    res.send(result);
  } catch (err) {
    console.error("place error:", err);
    res.status(500).send({ error: "internal_error" });
  }
}

function cleanText(input) {
  if (!input) return "";

  // 1. Remove emoji and symbols outside basic multilingual plane
  // (covers most emojis)
  const noEmojis = input.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");

  // 2. Collapse multiple spaces into one, and trim
  return noEmojis.replace(/\s+/g, " ").trim();
}

module.exports = router;

