const mongoose = require('mongoose');
const ProfileSchema = require('./ProfileSchema')

const schema = new mongoose.Schema(ProfileSchema, { timestamps: true })
const Profile = mongoose.model("ProfileSchema", schema)

module.exports = Profile