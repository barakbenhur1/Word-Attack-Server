const express = require("express");
const router = express();
const Profile = require("../Schemas/Profile/Profile");
const result = require("../Hendlers/Result");

router.post("/", function (req, res) {
  const email = req.body.email;
  const name = req.body.name;
  const language = req.body.language;
  login(email, name, language, res);
});

router.post("/changeLanguage", function (req, res) {
  const email = req.body.email;
  const language = req.body.language;
  changeLanguage(email, language, res);
});

async function login(email, name, language, res) {
  let profile = await Profile.findOne({ email: email });

  if (!result.exsit(profile)) {
    profile = await Profile({ email: email, name: name, language: language });
    profile.save();
  } else if (profile.language != language) {
    profile.language = language;
    profile.save();
  }

  res.send();
}

async function changeLanguage(email, language, res) {
  let profile = await Profile.findOne({ email: email });
  if (result.exsit(profile)) {
    profile.language = language;
    profile.save();
  }
  res.send();
}

module.exports = router;
