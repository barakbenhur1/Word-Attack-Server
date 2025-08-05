const express = require("express");
const bodyparser = require("body-parser");
const { auth } = require("express-openid-connect");
const app = express();
const server = app.listen(3000, () => {
  console.log("listening on *:3000");
});

server.timeout = 40000;

const login = require("./src/Routers/login");
const words = require("./src/Routers/words");
const https = require("https");

var options = {
  hostname: "www.howsmyssl.com",
  port: 443,
  path: "/a/check",
  method: "GET",
  secureProtocol: "TLSv1_2_method",
};

https
  .request(options, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => {
      data = JSON.parse(body);
      console.log("SSL Version: " + data.tls_version);
    });
  })
  .on("error", (err) => {
    // This gets called if a connection cannot be established.
    console.warn(err);
  })
  .end();

app.use(express.json());
app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());
app.use(express.static(__dirname + "/public"));
app.use("/uploads", express.static("uploads"));

const mongoose = require("mongoose");

mongoose.set("strictQuery", true);

mongoose
  .connect(
    "mongodb+srv://barakbenhur:4lOka9Z2n3vo8Pkl@cluster0.jr0ty.mongodb.net/"
  )
  .then(() => console.log("db connected"))
  .catch((err) => console.log(err));

const { v4: uuidv4 } = require("uuid");

app.use(
  auth({
    issuerBaseURL: "https://dev-8mxg4wjifqipa4jd.us.auth0.com",
    baseURL: "https://localhost:3000",
    clientID: "FvfmF4iT9SOC58fpKkAZYdKgZKj6b8wO",
    secret: uuidv4(),
    authRequired: false,
    auth0Logout: true,
  })
);

app.use((req, res, next) => {
  res.locals.isAuthenticated = req.oidc.isAuthenticated();
  next();
});

app.use("/login", login);
app.use("/words", words);

app.get("/", (req, res) => {
  res.send("hello world 2");
});
