const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const path = require("path");
const dns = require("dns");
const http = require("http");
const { execSync } = require("child_process");

const setupSocket = require("../backend/src/socket/socket");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

dns.setDefaultResultOrder("ipv4first");

// Run migrations before starting server
console.log("Running database migrations...");
try {
  execSync("npx prisma migrate deploy", { 
    stdio: "inherit",
    env: { ...process.env }
  });
  console.log("✓ Migrations completed");
} catch (error) {
  console.error("✗ Migration failed:", error.message);
  process.exit(1);
}

require("./src/config/passport");

const authRoutes = require("./src/routes/authRoutes");
const meetingRoutes = require("./src/routes/meetingRoutes");
const iceRoutes = require("./src/routes/iceRoutes");
const twilioRoute = require("./src/routes/twilioRoute");

const app = express();
app.set("trust proxy", 1);

const frontendUrl =
  process.env.FRONTEND_URL ||
  "https://google-meet-frontend-theta.vercel.app";
const allowedOrigins = new Set(
  [
    frontendUrl,
    ...(process.env.FRONTEND_URLS || "").split(","),
    "http://localhost:3000",
  ]
    .filter(Boolean)
    .map((url) => url.trim().replace(/\/$/, ""))
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
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
app.use("/api", iceRoutes);
app.use("/api", twilioRoute);

app.use("/meetings", meetingRoutes);
app.use("/api/meeting", meetingRoutes);
app.use("/api/meetings", meetingRoutes);

app.get("/", (req, res) => {
  res.send("Backend running");
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    status: err.status || 500,
  });
});

const server = http.createServer(app);

setupSocket(server);

const port = process.env.PORT || 5000;

server.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
