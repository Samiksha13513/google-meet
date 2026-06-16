const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

/**
 * Room Data Store (In-Memory)
 * roomId -> {
 *   hostId: string | null,
 *   activeMembers: Set<socketId>,
 *   pendingMembers: Set<socketId>,
 *   details: Map<socketId, { socketId, displayName, isMicOn, isCameraOn, isScreenSharing, isHost }>
 * }
 */
const rooms = new Map();
// userId -> Set<socketId>
const userSockets = new Map();

function addSocketForUser(userId, socketId) {
  if (!userId) return;
  const set = userSockets.get(userId) || new Set();
  set.add(socketId);
  userSockets.set(userId, set);
}

function removeSocketForUser(userId, socketId) {
  if (!userId) return;
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
}

function getSocketsForUser(userId) {
  return Array.from(userSockets.get(userId) || []);
}

function resolveIdentityLabel({ displayName, email }) {
  return (
    (email && String(email).trim()) ||
    (displayName && String(displayName).trim()) ||
    "Guest"
  );
}

function normalizeRoomId(payload) {
  if (typeof payload === "string") return payload.trim();
  return payload?.roomId || payload?.meetingCode || null;
}

async function touchRecentContact(userId, contactUserId, at = new Date()) {
  if (!userId || !contactUserId || userId === contactUserId) return;

  await prisma.recentContact.upsert({
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

function setupSocket(server) {
  const allowedOrigins = new Set(
    [
      process.env.FRONTEND_URL || "https://google-meet-frontend-theta.vercel.app",
      ...(process.env.FRONTEND_URLS || "").split(","),
      "http://localhost:3000",
    ]
      .filter(Boolean)
      .map((origin) => origin.trim().replace(/\/$/, ""))
  );

  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by Socket.IO CORS"));
        }
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  function handleUserLeaving(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    // 1. Clean up pending user
    if (room.pendingMembers.has(socket.id)) {
      room.pendingMembers.delete(socket.id);
      room.details.delete(socket.id);
      if (room.hostId) {
        io.to(room.hostId).emit("join-request-cancelled", { socketId: socket.id });
      }
      console.log(`[Socket] Pending join request cancelled by ${socket.id} in room ${roomId}`);
    }

    // 2. Clean up active user
    if (room.activeMembers.has(socket.id)) {
      const leavingDetails = room.details.get(socket.id);
      if (leavingDetails?.participantRecordId) {
        prisma.meetingParticipant
          .update({
            where: { id: leavingDetails.participantRecordId },
            data: { leftAt: new Date() },
          })
          .catch((err) =>
            console.warn("[Socket] participant leave persistence failed:", err.message)
          );
      }
      if (leavingDetails?.isScreenSharing) {
        socket.broadcast.to(roomId).emit("screen-share-stopped", {
          senderId: socket.id,
        });
      }

      room.activeMembers.delete(socket.id);
      room.details.delete(socket.id);
      socket.leave(roomId);

      io.to(roomId).emit("participant-left", { socketId: socket.id });
      console.log(`[Socket] User ${socket.id} left active room ${roomId}`);

      // 3. Host leaves; host authority returns only when the meeting creator rejoins.
      if (room.hostId === socket.id) {
        room.hostId = null;
      }
    }

    // 4. Delete room if completely empty
    if (room.activeMembers.size === 0 && room.pendingMembers.size === 0) {
      rooms.delete(roomId);
      console.log(`[Socket] Room ${roomId} completely deleted`);
    }
  }

  async function persistApprovedParticipant(roomId, socketId) {
    const room = rooms.get(roomId);
    const details = room?.details.get(socketId);
    if (!room || !details || details.participantRecordId) return;

    try {
      const meeting = await prisma.meeting.findUnique({
        where: { meetingCode: roomId },
        select: { id: true },
      });

      if (!meeting) return;

      const participant = await prisma.meetingParticipant.create({
        data: {
          meetingId: meeting.id,
          userId: details.userId || null,
          displayName: details.displayName || "Guest",
          email: details.email || null,
          avatar: details.image || null,
        },
      });

      details.participantRecordId = participant.id;

      if (details.userId) {
        const now = new Date();
        const otherUserIds = Array.from(room.activeMembers)
          .map((id) => room.details.get(id)?.userId)
          .filter((userId) => userId && userId !== details.userId);

        await Promise.all(
          otherUserIds.flatMap((otherUserId) => [
            touchRecentContact(details.userId, otherUserId, now),
            touchRecentContact(otherUserId, details.userId, now),
          ])
        );
      }
    } catch (err) {
      console.warn("[Socket] participant join persistence failed:", err.message);
    }
  }

  io.on("connection", (socket) => {
    console.log(new Date().toISOString(), "Socket connected:", socket.id);
    // Attach auth token (if provided) to socket for presence/calls
    socket.on("identify", async ({ token }) => {
      if (!token) return;
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          socket.userId = decoded.id;
          addSocketForUser(decoded.id, socket.id);
          // broadcast online presence
          io.emit("user-online", { userId: decoded.id });
        }
      } catch (err) {
        // ignore invalid token
      }
    });

    // Dynamic join request / waiting room admission
    socket.on("join-request", async ({ roomId: rawRoomId, token, displayName, isMicOn, isCameraOn }) => {
      const roomId = normalizeRoomId(rawRoomId);
      if (!roomId) return;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          hostId: null,
          activeMembers: new Set(),
          pendingMembers: new Set(),
          details: new Map(),
          messages: [],
        });
      }

      const room = rooms.get(roomId);

      const meeting = await prisma.meeting.findUnique({
        where: { meetingCode: roomId },
        select: { hostId: true, expiresAt: true },
      });

      if (!meeting) {
        socket.emit("join-denied", { reason: "Meeting not found" });
        return;
      }

      if (meeting.expiresAt < new Date()) {
        socket.emit("join-denied", { reason: "Meeting has expired" });
        return;
      }

      // Limit room size to 10 participants
      if (room.activeMembers.size >= 10) {
        socket.emit("join-denied", { reason: "Meeting is full" });
        return;
      }

      let email = "";
      let image = "";
      let authenticatedUserId = null;
      let resolvedDisplayName = displayName;

      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          if (decoded && decoded.id) {
            const user = await prisma.user.findUnique({
              where: { id: decoded.id }
            });
            if (user) {
              authenticatedUserId = user.id;
              resolvedDisplayName = user.name || user.email || displayName;
              email = user.email || "";
              image = user.avatar || user.image || "";
            }
          }
        } catch (err) {
          console.error("[Socket] token verification failed:", err.message);
        }
      }

      // Guest: show display name only, email and image must be empty
      if (!email) {
        email = "";
        image = "";
        resolvedDisplayName = displayName || `Guest ${socket.id.slice(0, 6)}`;
      }

      const isMeetingCreator = Boolean(authenticatedUserId && authenticatedUserId === meeting.hostId);
      const memberDetail = {
        socketId: socket.id,
        userId: authenticatedUserId,
        displayName: resolvedDisplayName,
        email,
        image,
        isMicOn: isMicOn !== false,
        isCameraOn: isCameraOn !== false,
        isHandRaised: false,
        isScreenSharing: false,
        isHost: isMeetingCreator,
      };

      room.details.set(socket.id, memberDetail);

      if (isMeetingCreator) {
        // Immediate approval only for the persisted meeting creator.
        room.activeMembers.add(socket.id);
        room.hostId = socket.id;
        socket.join(roomId);

        const otherActiveMembers = Array.from(room.activeMembers).filter(
          (id) => id !== socket.id
        );
        const membersList = otherActiveMembers
          .map((id) => room.details.get(id))
          .filter(Boolean);

        console.log(`[Socket] Meeting creator joined room ${roomId}. Host: ${socket.id}`);
        socket.emit("join-approved", {
          isHost: true,
          roomId,
          members: membersList,
          chatHistory: room.messages || [],
        });
        socket.broadcast.to(roomId).emit("participant-joined", memberDetail);
        void persistApprovedParticipant(roomId, socket.id);
        for (const pendingSocketId of room.pendingMembers) {
          const pendingDetails = room.details.get(pendingSocketId);
          if (!pendingDetails) continue;
          io.to(socket.id).emit("join-request", {
            socketId: pendingSocketId,
            displayName: pendingDetails.displayName,
            email: pendingDetails.email,
            image: pendingDetails.image,
          });
        }
      } else {
        // Waiting room flow for every non-host participant.
        room.pendingMembers.add(socket.id);
        socket.emit("waiting-room", { roomId });

        console.log(`[Socket] Join request from ${socket.id} in room ${roomId}`);
        if (room.hostId) {
          io.to(room.hostId).emit("join-request", {
            socketId: socket.id,
            displayName: memberDetail.displayName,
            email: memberDetail.email,
            image: memberDetail.image,
          });
        }
      }
    });

    

    // Host approves pending participant
    socket.on("approve-join", ({ roomId, socketId }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id) return;

      if (room.pendingMembers.has(socketId)) {
        room.pendingMembers.delete(socketId);
        room.activeMembers.add(socketId);

        const details = room.details.get(socketId);
        if (!details) return;
        details.isHost = false;

        // Fetch other active members details to supply to approved user
        const otherActiveMembers = Array.from(room.activeMembers).filter(
          (id) => id !== socketId
        );
        const membersList = otherActiveMembers
          .map((id) => room.details.get(id))
          .filter(Boolean);

        console.log(`[Socket] approve-join by ${socket.id} for ${socketId} — sending members:`, membersList);
        // approved socket joins room
        const approvedSocket = io.sockets.sockets.get(socketId);
        if (approvedSocket) {
          approvedSocket.join(roomId);
        }

        io.to(socketId).emit("join-approved", {
          isHost: false,
          roomId,
          members: membersList,
          chatHistory: room.messages || [],
        });

        // Notify active members in room
        io.to(roomId).emit("participant-joined", details);
        console.log(`[Socket] Host ${socket.id} approved ${socketId} in room ${roomId}`);
        void persistApprovedParticipant(roomId, socketId);
      }
    });

    // Host denies pending participant
    socket.on("deny-join", ({ roomId, socketId }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id) return;

      if (room.pendingMembers.has(socketId)) {
        room.pendingMembers.delete(socketId);
        room.details.delete(socketId);

        io.to(socketId).emit("join-denied", {
          reason: "Host denied your request",
        });
        console.log(`[Socket] Host ${socket.id} denied ${socketId} in room ${roomId}`);
      }
    });

    // Host kicks active participant
    socket.on("remove-participant", ({ roomId, socketId }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id) return;

      if (room.activeMembers.has(socketId)) {
        room.activeMembers.delete(socketId);
        room.details.delete(socketId);

        const kickedSocket = io.sockets.sockets.get(socketId);
        if (kickedSocket) {
          kickedSocket.leave(roomId);
        }

        io.to(socketId).emit("removed-from-meeting");
        io.to(roomId).emit("participant-left", { socketId });
        console.log(`[Socket] Host ${socket.id} removed ${socketId} in room ${roomId}`);
      }
    });

    // Hand raise updates
    socket.on("raise-hand", ({ roomId, isHandRaised }) => {
      const room = rooms.get(roomId);
      if (!room || !room.details.has(socket.id)) return;

      const details = room.details.get(socket.id);
      details.isHandRaised = Boolean(isHandRaised);

      socket.broadcast.to(roomId).emit("raise-hand-changed", {
        senderId: socket.id,
        isHandRaised: details.isHandRaised,
      });
    });

    // Host ends meeting for all participants
    socket.on("end-meeting-for-all", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id) return;

      io.to(roomId).emit("meeting-ended", {
        reason: "Host ended the meeting",
      });

      for (const memberId of [...room.activeMembers]) {
        const memberSocket = io.sockets.sockets.get(memberId);
        if (memberSocket) {
          memberSocket.leave(roomId);
        }
      }

      rooms.delete(roomId);
      console.log(`[Socket] Host ${socket.id} ended meeting for all in room ${roomId}`);
    });

    // User mic/camera status updates
    socket.on("status-update", ({ roomId, isMicOn, isCameraOn }) => {
      const room = rooms.get(roomId);
      if (!room || !room.details.has(socket.id)) return;

      const details = room.details.get(socket.id);
      if (isMicOn !== undefined) details.isMicOn = isMicOn;
      if (isCameraOn !== undefined) details.isCameraOn = isCameraOn;

      socket.broadcast.to(roomId).emit("participant-status-changed", {
        socketId: socket.id,
        isMicOn: details.isMicOn,
        isCameraOn: details.isCameraOn,
        isHandRaised: details.isHandRaised,
        displayName: details.displayName,
        email: details.email,
        image: details.image,
      });
    });

    socket.on("raise-hand", ({ roomId, isHandRaised }) => {
      const room = rooms.get(roomId);
      if (!room || !room.details.has(socket.id)) return;

      const details = room.details.get(socket.id);
      details.isHandRaised = Boolean(isHandRaised);

      socket.broadcast.to(roomId).emit("raise-hand-changed", {
        senderId: socket.id,
        isHandRaised: details.isHandRaised,
      });
    });

    // Mesh WebRTC direct signaling routing
    socket.on("offer", ({ roomId, offer, targetId }) => {
      if (!roomId || !offer || !targetId) return;
      io.to(targetId).emit("offer", {
        offer,
        senderId: socket.id,
      });
    });

    socket.on("answer", ({ roomId, answer, targetId }) => {
      if (!roomId || !answer || !targetId) return;
      io.to(targetId).emit("answer", {
        answer,
        senderId: socket.id,
      });
    });

    socket.on("ice-candidate", ({ roomId, candidate, targetId }) => {
      if (!roomId || !candidate || !targetId) return;
      io.to(targetId).emit("ice-candidate", {
        candidate,
        senderId: socket.id,
      });
    });

    // ------------------- Calls: basic signaling & notifications -------------------
    // Emit to receiver sockets that an incoming call exists
    socket.on("call-user", async ({ callId, toUserId, type, metadata }) => {
      if (!toUserId || !callId) return;
      try {
        const targets = getSocketsForUser(toUserId);
        targets.forEach((sId) => {
          io.to(sId).emit("incoming-call", {
            callId,
            fromSocketId: socket.id,
            fromUserId: socket.userId || null,
            type,
            metadata,
          });
        });
      } catch (err) {
        console.error("call-user error:", err);
      }
    });

    socket.on("call-accepted", ({ callId, toSocketId }) => {
      if (!callId || !toSocketId) return;
      io.to(toSocketId).emit("call-accepted", { callId, fromSocketId: socket.id });
    });

    socket.on("call-rejected", ({ callId, toSocketId }) => {
      if (!callId || !toSocketId) return;
      io.to(toSocketId).emit("call-rejected", { callId, fromSocketId: socket.id });
    });

    socket.on("call-ended", ({ callId, toSocketId, reason }) => {
      if (!callId) return;
      if (toSocketId) io.to(toSocketId).emit("call-ended", { callId, fromSocketId: socket.id, reason });
      // Also persist via prisma (best-effort)
      try {
        (async () => {
          const call = await prisma.call.findUnique({ where: { id: callId } });
          if (call) {
            await prisma.call.update({ where: { id: callId }, data: { status: "completed", endedAt: new Date() } });
            await prisma.callHistory.create({ data: { callId, callerId: call.callerId, receiverId: call.receiverId, status: "ended", createdAt: new Date() } });
          }
        })();
      } catch (err) {
        console.warn("call-ended persistence failed:", err.message);
      }
    });

    // Chat room messaging
    socket.on("send-message", ({ roomId, message, senderName }) => {
      if (!roomId || !message) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const details = room.details.get(socket.id);
      const payload = {
        id: `${Date.now()}-${socket.id}`,
        senderId: socket.id,
        senderName:
          details?.displayName ||
          senderName ||
          resolveIdentityLabel({ socketId: socket.id }),
        senderEmail: details?.email || "",
        senderImage: details?.image || "",
        message: String(message).trim(),
        timestamp: Date.now(),
      };
      if (!payload.message) return;

      room.messages = [...(room.messages || []), payload].slice(-200);
      io.to(roomId).emit("receive-message", payload);
    });

    // Real-time emoji reaction syncing
    socket.on("emoji-reaction", ({ roomId, emoji }) => {
      if (!roomId || !emoji) return;
      const room = rooms.get(roomId);
      const details = room?.details.get(socket.id);
      io.to(roomId).emit("emoji-reaction", {
        senderId: socket.id,
        senderUserId: details?.userId || null,
        emoji,
        timestamp: Date.now(),
        senderName: details?.displayName || resolveIdentityLabel({ socketId: socket.id }),
        senderEmail: details?.email || "",
        senderImage: details?.image || "",
      });
    });

    // Screen sharing status updates
    socket.on("screen-share-started", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || !room.details.has(socket.id)) return;

      room.details.get(socket.id).isScreenSharing = true;
      socket.broadcast.to(roomId).emit("screen-share-started", {
        senderId: socket.id,
      });
    });

    socket.on("screen-share-stopped", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || !room.details.has(socket.id)) return;

      room.details.get(socket.id).isScreenSharing = false;
      socket.broadcast.to(roomId).emit("screen-share-stopped", {
        senderId: socket.id,
      });
    });

    socket.on("leave-room", ({ roomId }) => {
      if (!roomId) return;
      handleUserLeaving(socket, roomId);
    });

    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;
        handleUserLeaving(socket, roomId);
      }
    });

    socket.on("disconnect", () => {
      console.log(new Date().toISOString(), "Socket disconnected:", socket.id);
      if (socket.userId) {
        removeSocketForUser(socket.userId, socket.id);
        // broadcast offline with last seen timestamp
        io.emit("user-offline", { userId: socket.userId, lastSeen: new Date().toISOString() });
      }
      
    });
  });
}

module.exports = setupSocket;
