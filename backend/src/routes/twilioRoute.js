const express = require("express");

const router = express.Router();

// Returns ephemeral TURN/STUN credentials from Twilio Network Traversal API.
// Requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in env.
// Endpoint: GET /api/twilio-ice

router.get("/twilio-ice", async (req, res) => {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !auth) {
      return res.status(500).json({ error: "Twilio credentials not configured" });
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Tokens.json`;

    const basic = Buffer.from(`${sid}:${auth}`).toString("base64");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Twilio token request failed:", resp.status, text);
      return res.status(502).json({ error: "Failed to fetch Twilio ICE servers" });
    }

    const body = await resp.json();

    // Twilio returns ice_servers in the response
    const iceServers = (body.ice_servers || body.iceServers || [])
      .map((server) => ({
        urls: server.urls || server.url,
        username: server.username,
        credential: server.credential,
        credentialType: server.credentialType,
      }))
      .filter((server) => Boolean(server.urls));

    return res.json({ iceServers });
  } catch (err) {
    console.error("twilio-ice error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
