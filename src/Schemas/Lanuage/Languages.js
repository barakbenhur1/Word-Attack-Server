const mongoose = require('mongoose');
const LanguagesSchema = require('./LanguagesSchema')

const schema = new mongoose.Schema(LanguagesSchema, { timestamps: true })
const Languages = mongoose.model("LanguagesSchema", schema)

module.exports = Languages