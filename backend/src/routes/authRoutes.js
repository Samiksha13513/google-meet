const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");

const router = express.Router();
const frontendUrl = (process.env.FRONTEND_URL || "https://google-meet-frontend-theta.vercel.app").replace(/\/$/, "");

router.get(
  "/google",
  passport.authenticate("google", {
    scope: "profile email",
  })
);


router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
  }),
  (req, res) => {
    try {
      console.log("Callback received, user:", req.user);
      
      if (!req.user) {
        console.error("User not found after authentication");
        return res.status(401).json({ error: "User not authenticated" });
      }

      const token = jwt.sign(
        {
          id: req.user.id,
          email: req.user.email,
        },
        process.env.JWT_SECRET,
        {
          expiresIn: "7d",
        }
      );

      const user = encodeURIComponent(
        JSON.stringify({
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
          image: req.user.image,
        })
      );

      console.log("Token generated successfully, redirecting to:", `${frontendUrl}/auth/callback`);
      res.redirect(`${frontendUrl}/auth/callback?token=${token}&user=${user}`);
    } catch (error) {
      console.error("Auth callback error:", error.message, error.stack);
      res.status(500).json({ error: "Internal server error", message: error.message });
    }
  }
);
module.exports = router;
