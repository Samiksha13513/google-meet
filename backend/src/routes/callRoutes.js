const express = require("express");
const prisma = require("../config/prisma");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

function generateMeetingCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const random = (length) =>
    Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");

  return `${random(3)}-${random(4)}-${random(3)}`;
}

function userSelect() {
  return { id: true, name: true, email: true, avatar: true, image: true, createdAt: true };
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name || user.email,
    email: user.email,
    avatar: user.avatar || user.image || "",
    createdAt: user.createdAt,
  };
}

function deriveCallType(call, userId) {
  if (call.callType) return call.callType;
  if (call.status === "missed") return "missed";
  return call.callerId === userId ? "outgoing" : "incoming";
}

async function createMeetingForUser(tx, hostId) {
  let retries = 0;

  while (retries < 5) {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      return await tx.meeting.create({
        data: {
          meetingCode: generateMeetingCode(),
          hostId,
          expiresAt,
        },
      });
    } catch (error) {
      if (error.code !== "P2002") throw error;
      retries += 1;
    }
  }

  throw new Error("Failed to generate unique meeting code");
}

async function touchRecentContact(tx, userId, contactUserId, at = new Date()) {
  if (!userId || !contactUserId || userId === contactUserId) return;

  await tx.recentContact.upsert({
    where: {
      userId_contactUserId: {
        userId,
        contactUserId,
      },
    },
    update: { lastInteractionAt: at },
    create: {
      userId,
      contactUserId,
      lastInteractionAt: at,
    },
  });
}

// GET contacts for Meet-style search modal
router.get("/contacts", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    const q = String(req.query.q || "").trim();

    const searchWhere = q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : {};

    const recentRows = await prisma.recentContact.findMany({
      where: {
        userId,
        ...(q ? { contactUser: { is: searchWhere } } : {}),
      },
      orderBy: { lastInteractionAt: "desc" },
      take: 12,
      include: {
        contactUser: { select: userSelect() },
      },
    });

    const recentIds = new Set(recentRows.map((row) => row.contactUserId));

    const allUsers = await prisma.user.findMany({
      where: {
        id: { not: userId },
        ...searchWhere,
      },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: 40,
      select: userSelect(),
    });

    res.json({
      success: true,
      recentContacts: recentRows.map((row) => ({
        id: row.id,
        lastInteractionAt: row.lastInteractionAt,
        user: toPublicUser(row.contactUser),
      })),
      users: allUsers
        .filter((user) => !recentIds.has(user.id))
        .map(toPublicUser),
    });
  } catch (err) {
    console.error("GET /calls/contacts error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
          caller: { select: userSelect() },
          receiver: { select: userSelect() },
          meeting: { select: { id: true, meetingCode: true } },
        },
      }),
      prisma.call.count({ where }),
    ]);

    res.json({
      success: true,
      items: items.map((call) => {
        const otherUser = call.callerId === userId ? call.receiver : call.caller;
        return {
          id: call.id,
          meetingId: call.meetingId,
          meetingCode: call.meeting?.meetingCode || null,
          callType: deriveCallType(call, userId),
          status: call.status,
          type: call.type,
          startedAt: call.startedAt || call.createdAt,
          endedAt: call.endedAt,
          duration: call.duration,
          createdAt: call.createdAt,
          caller: toPublicUser(call.caller),
          receiver: toPublicUser(call.receiver),
          otherUser: toPublicUser(otherUser),
        };
      }),
      total,
      page: parseInt(page, 10),
      perPage: take,
    });
  } catch (err) {
    console.error("GET /calls/history error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /calls/video-call - create meeting, call, recent contacts, and return meeting link/code
router.post("/video-call", authMiddleware, async (req, res) => {
  try {
    const callerId = req.user.id;
    const { receiverId } = req.body;

    if (!receiverId) {
      return res.status(400).json({ success: false, error: "receiverId required" });
    }

    if (receiverId === callerId) {
      return res.status(400).json({ success: false, error: "Cannot call yourself" });
    }

    const receiver = await prisma.user.findUnique({
      where: { id: receiverId },
      select: { id: true },
    });

    if (!receiver) {
      return res.status(404).json({ success: false, error: "Contact not found" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const meeting = await createMeetingForUser(tx, callerId);

      const call = await tx.call.create({
        data: {
          callerId,
          receiverId,
          meetingId: meeting.id,
          callType: "outgoing",
          type: "video",
          status: "completed",
          startedAt: now,
        },
      });

      await Promise.all([
        touchRecentContact(tx, callerId, receiverId, now),
        touchRecentContact(tx, receiverId, callerId, now),
      ]);

      return { meeting, call };
    });

    res.status(201).json({
      success: true,
      meeting: result.meeting,
      meetingCode: result.meeting.meetingCode,
      call: result.call,
    });
  } catch (err) {
    console.error("POST /calls/video-call error:", err);
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
