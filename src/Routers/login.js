const express = require("express");
const router = express();
const Profile = require("../Schemas/Profile/Profile");
const result = require("../Hendlers/Result");

router.post("/", function (req, res) {
  const uniqe = req.body.uniqe;
  const email = req.body.email;
  const name = req.body.name;
  const gender = req.body.gender;
  const language = req.body.language;
  login(uniqe, email, name, gender, language, res);
});

router.post("/isLoggedin", function (req, res) {
  const uniqe = req.body.uniqe;
  isLoggedin(uniqe, res);
});

router.post("/changeLanguage", function (req, res) {
  const uniqe = req.body.uniqe;
  const language = req.body.language;
  changeLanguage(uniqe, language, res);
});

router.post("/gender", function (req, res) {
  const uniqe = req.body.uniqe;
  getGender(uniqe, res);
});

async function isLoggedin(uniqe, res) {
  let profile = await Profile.findOne({ uniqe: uniqe });
  const value = result.exsit(profile) ? {} : null;
  res.send(value);
}

async function login(uniqe, email, name, gender, language, res) {
  let profile = await Profile.findOne({ uniqe: uniqe });

  if (!result.exsit(profile)) {
    profile = await Profile({
      uniqe: uniqe,
      email: email,
      name: name,
      gender: gender,
      language: language,
    });
    profile.save();
  } else {
    let save = false;
     if (profile.email.length == 0 || profile.email != email) {
      profile.email = email;
      save = true;
    }
    if (profile.language != language) {
      profile.language = language;
      save = true;
    }
    if (profile.name.length > 0 && profile.name != name) {
      profile.name = name;
      save = true;
    }
    if (profile.gender.length > 0 && profile.gender != gender) {
      profile.gender = gender;
      save = true;
    }
    if (save) {
      profile.save();
    }
  }
  res.send({});
}

async function getGender(uniqe, res) {
  let profile = await Profile.findOne({ uniqe: uniqe });
  if (result.exsit(profile)) {
    res.send({ gender: profile.gender });
  } else {
    res.send({ gender: null });
  }
}

async function changeLanguage(uniqe, language, res) {
  let profile = await Profile.findOne({ uniqe: uniqe });
  if (result.exsit(profile)) {
    if (profile.language != language) {
      profile.language = language;
      profile.save();
    }
    res.send({});
  } else {
    res.send(null);
  }
}

module.exports = router;
