const schema = {
    email: String,
    name: String,
    gender: String,
    language: String,
    premiumScore:{ type: Number, default: 0 },
}

module.exports = schema