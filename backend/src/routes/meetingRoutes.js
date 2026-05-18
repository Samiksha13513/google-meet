const express = require("express");
const prisma = require("../config/prisma");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// generate meeting code
function generateMeetingCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz";

  const random = (length) =>
    Array.from({ length }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");

  return `${random(3)}-${random(4)}-${random(3)}`;
}

router.post("/create", authMiddleware, async (req, res) => {
  try {
    // ✅ safety check (VERY IMPORTANT)
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        message: "Unauthorized: user not found in token",
      });
    }

    const meetingCode = generateMeetingCode();

    const meeting = await prisma.meeting.create({
      data: {
        meetingCode,
        hostId: req.user.id,
      },
    });

    return res.status(201).json({
      message: "Meeting created successfully",
      meeting,
    });

  } catch (error) {
    console.log("Meeting creation error:", error);

    return res.status(500).json({
      message: "Server error while creating meeting",
      error: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
});

module.exports = router;