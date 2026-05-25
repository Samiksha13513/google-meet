const express = require("express");
const prisma = require("../config/prisma");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();


function generateMeetingCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz";

  const random = (length) =>
    Array.from({ length }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");

  return `${random(3)}-${random(4)}-${random(3)}`;
}

// CREATE MEETING
router.post(
  "/create",
  authMiddleware,
  async (req, res) => {
    try {
      // safety check
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          message:
            "Unauthorized: user not found in token",
        });
      }

      // Retry logic for unique constraint violation (P2002)
      let meeting;
      let retries = 0;
      const maxRetries = 5;

      while (retries < maxRetries) {
        try {
          const meetingCode = generateMeetingCode();
          // Set expiration to 24 hours from now
          const expiresAt = new Date();
          expiresAt.setHours(expiresAt.getHours() + 24);

          meeting = await prisma.meeting.create({
            data: {
              meetingCode,
              hostId: req.user.id,
              expiresAt,
            },
          });

          break; // Success, exit retry loop
        } catch (error) {
          // Check if it's a unique constraint violation (P2002)
          if (error.code === "P2002") {
            retries++;
            console.log(
              `Meeting code collision detected. Retry ${retries}/${maxRetries}`
            );

            if (retries >= maxRetries) {
              throw new Error(
                "Failed to generate unique meeting code after multiple attempts"
              );
            }
            // Continue to next iteration to retry with new code
          } else {
            // Not a constraint violation, rethrow
            throw error;
          }
        }
      }

      return res.status(201).json({
        success: true,
        message:
          "Meeting created successfully",
        meeting,
      });
    } catch (error) {
      console.log(
        "Meeting creation error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Server error while creating meeting",
        error:
          process.env.NODE_ENV ===
          "production"
            ? undefined
            : error.message,
      });
    }
  }
);

// GET MEETING BY CODE
router.get(
  "/:meetingCode",
  async (req, res) => {
    try {
      const { meetingCode } = req.params;

      const meeting =
        await prisma.meeting.findUnique({
          where: {
            meetingCode,
          },
        });

      if (!meeting) {
        return res.status(404).json({
          success: false,
          message: "Meeting not found",
        });
      }

      // Check if meeting has expired
      const now = new Date();
      if (meeting.expiresAt < now) {
        return res.status(410).json({
          success: false,
          message: "Meeting has expired",
          expiresAt: meeting.expiresAt,
        });
      }

      return res.status(200).json({
        success: true,
        meeting,
      });
    } catch (error) {
      console.log(
        "Get meeting error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Server error while fetching meeting",
      });
    }
  }
);

module.exports = router;