const express = require("express");
const router = express();
const Profile = require("../Schemas/Profile/Profile");
const result = require("../Hendlers/Result");

router.post("/", function (req, res) {
  const email = req.body.email;
  const name = req.body.name;
  const gender = req.body.gender;
  const language = req.body.language;
  login(email, name, gender, language, res);
});

router.post("/changeLanguage", function (req, res) {
  const email = req.body.email;
  const language = req.body.language;
  changeLanguage(email, language, res);
});

router.post("/gender", function (req, res) {
  const email = req.body.email;
  getGender(email, res);
});

async function login(email, name, gender, language, res) {
  let profile = await Profile.findOne({ email: email });

  if (!result.exsit(profile)) {
    profile = await Profile({
      email: email,
      name: name,
      gender: gender,
      language: language,
    });
    profile.save();
  } else if (profile.language != language) {
    profile.language = language;
    profile.save();
  }
  res.send({});
}

async function getGender(email, res) {
  let profile = await Profile.findOne({ email: email });
  if (result.exsit(profile)) {
    res.send({ gender: profile.gender });
  } else {
    res.send({ gender: null });
  }
}

async function changeLanguage(email, language, res) {
  let profile = await Profile.findOne({ email: email });
  if (result.exsit(profile)) {
    profile.language = language;
    profile.save();
    res.send({});
  } else {
    res.send(null);
  }
}

module.exports = router;
