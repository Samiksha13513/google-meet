const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");

const router = express.Router();
const frontendUrl = (
  process.env.FRONTEND_URL || "https://google-meet-frontend-theta.vercel.app"
).replace(/\/$/, "");

function safeReturnPath(value) {
  if (!value || typeof value !== "string") return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

router.get("/google", (req, res, next) => {
  const returnTo = safeReturnPath(req.query.returnTo);
  passport.authenticate("google", {
    scope: ["profile", "email"],
    state: Buffer.from(JSON.stringify({ returnTo })).toString("base64url"),
  })(req, res, next);
});

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: `${frontendUrl}/?authError=google_signin_failed`,
  }),
  (req, res) => {
    try {
      if (!req.user) {
        return res.redirect(
          `${frontendUrl}/?authError=${encodeURIComponent("User not authenticated")}`
        );
      }

      const token = jwt.sign(
        { id: req.user.id, email: req.user.email },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      const userPayload = encodeURIComponent(
        JSON.stringify({
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
          image: req.user.image,
        })
      );

      let returnTo = "/dashboard";
      try {
        if (req.query.state) {
          const state = JSON.parse(
            Buffer.from(String(req.query.state), "base64url").toString("utf8")
          );
          returnTo = safeReturnPath(state.returnTo);
        }
      } catch {
        // use default
      }

      const redirectUrl = `${frontendUrl}/auth/callback?token=${token}&user=${userPayload}&returnTo=${encodeURIComponent(returnTo)}`;
      res.redirect(redirectUrl);
    } catch (error) {
      console.error("Auth callback error:", error.message);
      res.redirect(
        `${frontendUrl}/?authError=${encodeURIComponent("Internal server error")}`
      );
    }
  }
);

module.exports = router;
