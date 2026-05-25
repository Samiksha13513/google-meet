const express = require("express");

const router = express.Router();

// Returns ICE server configuration for clients.
// Priority:
// 1. If ICE_SERVERS_JSON env var is provided (stringified array), parse and return it.
// 2. Else include default public STUN server and any TURN server provided via
//    TURN_URL / TURN_USERNAME / TURN_PASSWORD env variables.

router.get("/ice", (req, res) => {
  try {
    if (process.env.ICE_SERVERS_JSON) {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      return res.json({ iceServers: parsed });
    }

    const iceServers = [
      { urls: ["stun:stun.l.google.com:19302"] },
    ];

    if (process.env.TURN_URL) {
      const turn = { urls: process.env.TURN_URL };
      if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
      if (process.env.TURN_PASSWORD) turn.credential = process.env.TURN_PASSWORD;
      iceServers.push(turn);
    }

    // Example: support TURN servers list separated by ;
    if (process.env.TURN_URLS) {
      const urls = process.env.TURN_URLS.split(";").map((u) => u.trim()).filter(Boolean);
      urls.forEach((u) => {
        iceServers.push({ urls: u, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
      });
    }

    return res.json({ iceServers });
  } catch (error) {
    console.error("Failed to build ICE servers:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
