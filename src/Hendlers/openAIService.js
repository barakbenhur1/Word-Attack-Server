// openaiService.js
require('dotenv').config();
const axios = require('axios');

const apiKey = process.env.OPENAI_API_KEY;

const OpenAI = require("openai");

const openai = new OpenAI(apiKey);

const openAIService = {
    fetchResponse: async (prompt) => {
        const completion = await openai.chat.completions.create({
            messages: [{ role: "system", content: prompt }],
            model: "gpt-3.5-turbo",
          });

          console.log(completion.choices[0])
        
         return completion.choices[0]
    }
};

module.exports = openAIService;
