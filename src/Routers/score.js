const express = require("express");
const router = express();
const Profile = require("../Schemas/Profile/Profile");
const Languages = require("../Schemas/Lanuage/Languages");
const memberProvider = require("../Hendlers/Member");
const misc = require("../Hendlers/Result");
const { name } = require("../Schemas/Profile/ProfileSchema");

router.post("/score", function (req, res) {
  const diffculty = req.body.diffculty;
  const email = req.body.email;
  score(diffculty, email, res);
});

router.post("/premiumScore", function (req, res) {
  const email = req.body.email;
  premiumScore(email, res);
});

router.post("/getPremiumScore", function (req, res) {
  const email = req.body.email;
  getPremiumScore(email, res);
});

router.post("/getAllPremiumScores", function (req, res) {
  const email = req.body.email;
  getAllPremiumScores(email, res);
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

  const language = await Languages.findOne(
    { value: profile.language },
    { days: 1 }
  );
  return language?.days ?? [];
}

async function scoreboard(email, res) {
  const days = await getDaysForUser(email);
  res.send(days);
}

async function getPremiumScores(email) {
  const profile = await Profile.findOne({ email: email });
  const languageKey = profile.language;
  let language = await Languages.findOne(
    { value: languageKey },
    { premium: 1 }
  );

  if (!misc.exsit(language)) {
    return [];
  }

  let premiumMembers = language.premium;

  // same language premiumScore for all peers
  const out = premiumMembers.map((p) => ({
    name: p.name,
    email: p.email,
    value: p.premiumScore,
    rank: premiumMembers.findIndex(o => o.email === p.email) + 1,
  }));

  return out;
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

async function premiumScore(email, res) {
  let member = await memberProvider.getPremium(email);
  if (member == null) {
    const profile = await Profile.findOne({ email: email });

    const languageKey = profile.language;

    let language = await Languages.findOne(
      { value: languageKey },
      { premium: 1 }
    );

    language.premium.push({
      email: profile.email,
      name: profile.name,
      premiumScore: 0,
    });

    language.save();

    member = [language, await memberProvider.getPremium(email)];
  }

  member[1].premiumScore += 1;

  member[0].premium.sort((a, b) => b.premiumScore - a.premiumScore);

  member[0].save();

  res.send({});
}

async function getPremiumScore(email, res) {
  const allSocres = await getPremiumScores(email);

  const idx = allSocres.findIndex(o => o.email === email);

  const member = idx >= 0 ? allSocres[idx] : null;
  if (member != null) {
    return res.send({
      name: member.name,
      email: member.email,
      value: member.value,
      rank: member.rank,
    });
  }

  const profile = await Profile.findOne({ email: email });
  res.send({ name: profile.name ?? "", email: email, value: 0 });
}

async function getAllPremiumScores(email, res) {
  // find the caller's profile to get its language
  const out = await getPremiumScores(email);
  res.send(out);
}

async function place(email, res) {
  try {
    const days = await getDaysForUser(email);
    if (!days.length) {
      return res.status(404).send({ easy: null, medium: null, hard: null });
    }

    // pick the last day (assuming array is ordered chronologically)
    const lastDay = days[days.length - 1];
    const difficulties = Array.isArray(lastDay.difficulties)
      ? lastDay.difficulties
      : [];

    const result = { easy: null, medium: null, hard: null };

    for (const diff of difficulties) {
      const key = String(diff.value || "").toLowerCase();
      const members = Array.isArray(diff.members) ? diff.members : [];

      const sorted = [...members].sort(
        (a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0)
      );

      const idx = sorted.findIndex(
        (m) =>
          String(m.email || "").toLowerCase() === String(email).toLowerCase()
      );

      if (idx >= 0) {
        result[misc.cleanText(key)] = idx + 1; // 1-based place
      }
    }

    res.send(result);
  } catch (err) {
    console.error("place error:", err);
    res.status(500).send({ error: "internal_error" });
  }
}

module.exports = router;
