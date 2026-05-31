const express = require("express");
const prisma = require("../config/prisma");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// GET call history (paginated)
router.get("/history", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { page = 1, perPage = 20 } = req.query;
    const take = Math.min(parseInt(perPage, 10) || 20, 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = {
      OR: [
        { callerId: userId },
        { receiverId: userId },
      ],
    };

    const [items, total] = await Promise.all([
      prisma.call.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: {
          caller: { select: { id: true, name: true, email: true, image: true } },
          receiver: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
      prisma.call.count({ where }),
    ]);

    res.json({ success: true, items, total, page: parseInt(page, 10), perPage: take });
  } catch (err) {
    console.error("GET /calls/history error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /calls/create
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { receiverId, type = "video" } = req.body;
    if (!receiverId) return res.status(400).json({ success: false, error: "receiverId required" });

    const call = await prisma.call.create({
      data: {
        callerId: userId,
        receiverId,
        type,
        status: "ringing",
      },
    });

    res.status(201).json({ success: true, call });
  } catch (err) {
    console.error("POST /calls/create error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /calls/accept
router.post("/accept", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ success: false, error: "callId required" });

    const call = await prisma.call.updateMany({
      where: { id: callId, receiverId: userId },
      data: { status: "completed", startedAt: new Date() },
    });

    // create history entry
    await prisma.callHistory.create({
      data: {
        callId,
        callerId: (await prisma.call.findUnique({ where: { id: callId } })).callerId,
        receiverId: userId,
        status: "accepted",
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /calls/accept error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /calls/reject
router.post("/reject", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ success: false, error: "callId required" });

    await prisma.call.updateMany({ where: { id: callId, receiverId: userId }, data: { status: "rejected", endedAt: new Date() } });

    await prisma.callHistory.create({
      data: {
        callId,
        callerId: (await prisma.call.findUnique({ where: { id: callId } })).callerId,
        receiverId: userId,
        status: "rejected",
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /calls/reject error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /calls/end
router.post("/end", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { callId, duration = 0 } = req.body;
    if (!callId) return res.status(400).json({ success: false, error: "callId required" });

    await prisma.call.updateMany({ where: { id: callId }, data: { status: "completed", endedAt: new Date(), duration } });

    await prisma.callHistory.create({
      data: {
        callId,
        callerId: (await prisma.call.findUnique({ where: { id: callId } })).callerId,
        receiverId: (await prisma.call.findUnique({ where: { id: callId } })).receiverId,
        status: "ended",
        duration,
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /calls/end error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
