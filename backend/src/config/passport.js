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
        console.log("Google profile received:", { id: profile.id, email, name: profile.displayName });

        if (!email) {
          console.error("Email not provided by Google");
          return done(new Error("Google account did not provide an email"), null);
        }

        let user = await prisma.user.findUnique({
          where: {
            email,
          },
        });

        if (!user) {
          console.log("Creating new user:", email);
          user = await prisma.user.create({
            data: {
              googleId: profile.id,
              name: profile.displayName,
              email,
              avatar: profile.photos?.[0]?.value,
              image: profile.photos?.[0]?.value,
            },
          });
          console.log("User created successfully:", user.id);
        } else if (!user.googleId) {
          console.log("Updating existing user with googleId:", user.id);
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              googleId: profile.id,
              avatar: user.avatar || user.image || profile.photos?.[0]?.value,
              image: user.image || profile.photos?.[0]?.value,
            },
          });
          console.log("User updated successfully");
        }

        console.log("Calling done with user:", user.id);
        done(null, user);
      } catch (error) {
        console.error("Passport strategy error:", error.message, error.stack);
        done(error, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id },
    });

    done(null, user);
  } catch (error) {
    console.error("Deserialization error:", error);
    done(error, null);
  }
});
