const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const prisma = require("./prisma");

const backendUrl = (process.env.BACKEND_URL || "http://localhost:5000").replace(/\/$/, "");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${backendUrl}/auth/google/callback`,
      tokenURL: "https://oauth2.googleapis.com/token",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
      scope: "profile email",
    },

    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;

        if (!email) {
          return done(new Error("Google account did not provide an email"), null);
        }

        let user = await prisma.user.findUnique({
          where: {
            email,
          },
        });

        if (!user) {
          user = await prisma.user.create({
            data: {
              googleId: profile.id,
              name: profile.displayName,
              email,
              image: profile.photos?.[0]?.value,
            },
          });
        } else if (!user.googleId) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              googleId: profile.id,
              image: user.image || profile.photos?.[0]?.value,
            },
          });
        }

        done(null, user);
      } catch (error) {
        done(error, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  const user = await prisma.user.findUnique({
    where: { id },
  });

  done(null, user);
});
