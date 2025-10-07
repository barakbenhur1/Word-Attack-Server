const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const DeviceSchema = new mongoose.Schema({
  uniqe: { type: String, index: true },
  token: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
});
const Device = mongoose.models.Device || mongoose.model("Device", DeviceSchema);

// Client calls this after it gets an APNs device token
router.post("/register", async (req, res) => {
  try {
    const { uniqe, token } = req.body || {};
    if (!uniqe || !token) return res.status(400).json({ error: "missing uniqe or token" });

    await Device.updateOne(
      { token },
      { $set: { uniqe, token, createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("device register error:", e);
    res.status(500).json({ error: "device_register_failed" });
  }
});

module.exports = router;
