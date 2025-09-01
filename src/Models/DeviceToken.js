// models/DeviceToken.js
const mongoose = require("mongoose");

const deviceTokenSchema = new mongoose.Schema(
  {
    email: { type: String, index: true, required: true },
    token: { type: String, index: true, required: true, unique: true },
    platform: { type: String, enum: ["ios"], default: "ios" },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// one email can have multiple devices; we de-dup by token
module.exports = mongoose.model("DeviceToken", deviceTokenSchema);
