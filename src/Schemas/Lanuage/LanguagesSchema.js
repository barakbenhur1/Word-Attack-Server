const { uniqe } = require("../Profile/ProfileSchema");

const Word = {
  value: String,
  guesswork: { type: [String], default: [] },
  done: { type: Boolean, default: false },
};

const Member = {
  uniqe: String,
  name: String,
  totalScore:{ type: Number, default: 0 },
  words: { type: [Word], default: [] },
};

const PremiumMember = {
  uniqe: String,
  name: String,
  premiumScore:{ type: Number, default: 0 },
};

const Diffculty = {
  value: String,
  words: { type: [String], default: [] },
  members: { type: [Member], default: [] },
};

const Day = {
  value: String,
  difficulties: { type: [Diffculty], default: [] },
};

const schema = {
  value: String,
  days: { type: [Day], default: [] },
  premium: { type: [PremiumMember], default: [] },
};

module.exports = schema;
