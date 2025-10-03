const express = require("express");
const router = express();
const Profile = require("../Schemas/Profile/Profile");
const Languages = require("../Schemas/Lanuage/Languages");
const memberProvider = require("../Hendlers/Member");
const misc = require("../Hendlers/Result");

router.post("/score", function (req, res) {
  const diffculty = req.body.diffculty;
  const email = req.body.email;
  score(diffculty, email, res);
});

router.post("/getScore", function (req, res) {
  const diffculty = req.body.diffculty;
  const email = req.body.email;
  getScore(diffculty, email, res);
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
  const profile = await Profile.findOne({ email: email });
  if (!misc.exsit(profile)) {
    return [];
  }
  const languageKey = profile.language;
  const language = await Languages.findOne({ value: languageKey }, { days: 1 });

  if (!misc.exsit(language)) {
    return [];
  }

  return language.days;
}

async function scoreboard(email, res) {
  const days = await getDaysForUser(email);
  res.send(days);
}

async function getPremiumScores(email) {
  const profile = await Profile.findOne({ email: email });
  if (!misc.exsit(profile)) {
    return [];
  }
  const languageKey = profile.language;
  const language = await Languages.findOne(
    { value: languageKey },
    { premium: 1 }
  );

  if (!misc.exsit(language)) {
    return [];
  }

  const premiumMembers = language.premium;

  // same language premiumScore for all peers
  const out = premiumMembers.map((p) => ({
    name: p.name,
    email: p.email,
    value: p.premiumScore,
    rank: premiumMembers.findIndex((o) => o.email === p.email) + 1,
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

async function getScore(diffcultyKey, email, res) {
  let member = await memberProvider.get(diffcultyKey, email);
  if (member != null) {
    res.send({ score: member[0].totalScore });
    return;
  }
  res.send({ score: 0 });
}

async function premiumScore(email, res) {
  try {
    const result = await memberProvider.getPremium(email);
    if (!result || !Array.isArray(result) || result.length < 2) {
      return res.status(404).json({ ok: false, error: "Member not found" });
    }

    const [playerDoc, boardDoc] = result;

    // 1) increment player's premium score
    const inc = () => {
      playerDoc.premiumScore = (playerDoc.premiumScore || 0) + 1;
    };

    // playerDoc is embedded → save its owner document
    inc();
    boardDoc.markModified("premium");
    await boardDoc.save();

    // 2) re-sort leaderboard array on the board doc (if present)
    if (boardDoc && Array.isArray(boardDoc.premium)) {
      boardDoc.premium.sort(
        (a, b) => (b.premiumScore || 0) - (a.premiumScore || 0)
      );
      if (typeof boardDoc.markModified === "function") {
        boardDoc.markModified("premium");
      }
      await boardDoc.save();
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[premiumScore] error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
}

async function getPremiumScore(email, res) {
  const allSocres = await getPremiumScores(email);

  const idx = allSocres.findIndex((o) => o.email === email);

  const member = idx >= 0 ? allSocres[idx] : null;
  if (misc.exsit(member)) {
    res.send({
      name: member.name,
      email: member.email,
      value: member.value,
      rank: member.rank,
    });
  } else {
    let name = "unknowen";
    const profile = await Profile.findOne({ email: email });
    if (misc.exsit(profile)) {
      name = profile.name;
    }

    res.send({
      name: name,
      email: email,
      value: 0,
      rank: Number.MAX_SAFE_INTEGER,
    });
  }
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
