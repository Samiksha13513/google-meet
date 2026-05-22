const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");

const router = express.Router();
const frontendUrl = process.env.FRONTEND_URL || "https://google-meet-frontend-theta.vercel.app/";

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

    res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
  }
);
module.exports = router;
