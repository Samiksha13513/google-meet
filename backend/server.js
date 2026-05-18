const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const path = require("path");
const dns = require("dns");

require("dotenv").config({ path: path.join(__dirname, ".env") });

dns.setDefaultResultOrder("ipv4first");

require("./src/config/passport");

const authRoutes = require("./src/routes/authRoutes");

const app = express();
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
const meetingRoutes = require("./src/routes/meetingRoutes");

app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
  })
);

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use("/auth", authRoutes);
app.use("/meetings", meetingRoutes);

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.listen(5000, () => {
  console.log("Server running on port 5000");
});
