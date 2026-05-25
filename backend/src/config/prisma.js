const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  errorFormat: "pretty",
});

prisma.$connect()
  .then(() => console.log("✓ Database connected"))
  .catch((err) => {
    console.error("✗ Database connection failed:", err.message);
    process.exit(1);
  });

module.exports = prisma;