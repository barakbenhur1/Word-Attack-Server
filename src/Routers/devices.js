const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const DeviceSchema = new mongoose.Schema({
  email: { type: String, index: true },
  token: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
});
const Device = mongoose.models.Device || mongoose.model("Device", DeviceSchema);

// Client calls this after it gets an APNs device token
router.post("/register", async (req, res) => {
  try {
    const { email, token } = req.body || {};
    if (!email || !token) return res.status(400).json({ error: "missing email or token" });

    await Device.updateOne(
      { token },
      { $set: { email, token, createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("device register error:", e);
    res.status(500).json({ error: "device_register_failed" });
  }
});

module.exports = router;
