// src/services/notify.js
const DeviceToken = require("../Models/DeviceToken");
const { sendSilentToMany } = require("../Utils/apns");

/** Call this after you persist new data for a user */
async function notifyUserRefresh(email, extraArgs = undefined) {
  const devices = await DeviceToken.find({ email }).select("token -_id");
  if (!devices.length) return { pushed: 0 };
  const tokens = devices.map((d) => d.token);
  const results = await sendSilentToMany(tokens, { type: "wordzap.refresh", args: extraArgs });
  return { pushed: tokens.length, results };
}

async function notifyAllUsers(extraArgs = undefined) {
  const devices = await DeviceToken.find().select("token -_id");
  if (!devices.length) return { pushed: 0 };
  const tokens = devices.map((d) => d.token);
  const results = await sendSilentToMany(tokens, { type: "wordzap.refresh", args: extraArgs });
  return { pushed: tokens.length, results };
}

module.exports = { notifyUserRefresh, notifyAllUsers };
