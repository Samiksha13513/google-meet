const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

const WAITING_LOBBY_TIMEOUT_MS = Number(process.env.WAITING_LOBBY_TIMEOUT_MS || 15 * 60 * 1000);
const MAX_MEETING_DURATION_MS = Number(process.env.MAX_MEETING_DURATION_MS || 24 * 60 * 60 * 1000);
const MEETING_END_WARNING_MS = Number(process.env.MEETING_END_WARNING_MS || 5 * 60 * 1000);

/**
 * Room Data Store (In-Memory)
 * roomId -> {
 *   hostId: string | null,
 *   activeMembers: Set<socketId>,
 *   pendingMembers: Set<socketId>,
 *   admittedUserIds: Set<userId>,
 *   admittedClientIds: Set<clientId>,
 *   disconnectTimers: Map<socketId, Timeout>,
 *   pendingTimers: Map<socketId, Timeout>,
 *   details: Map<socketId, { socketId, displayName, isMicOn, isCameraOn, isScreenSharing, isHost }>
 *   activeScreenSharerId: string | null,
 *   activityIds: Set<string>
 * }
 */
const rooms = new Map();
const endedMeetings = new Set();
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

function createRoomState() {
  return {
    hostId: null,
    activeMembers: new Set(),
    pendingMembers: new Set(),
    admittedUserIds: new Set(),
    admittedClientIds: new Set(),
    disconnectTimers: new Map(),
    pendingTimers: new Map(),
    createdAt: Date.now(),
    endsAt: null,
    warningTimer: null,
    endTimer: null,
    activeScreenSharerId: null,
    activityIds: new Set(),
    details: new Map(),
    messages: [],
  };
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

  function clearPendingTimer(room, socketId) {
    const timer = room?.pendingTimers?.get(socketId);
    if (!timer) return;
    clearTimeout(timer);
    room.pendingTimers.delete(socketId);
  }

  function clearRoomTimers(room) {
    for (const timer of room.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of room.pendingTimers.values()) {
      clearTimeout(timer);
    }
    if (room.warningTimer) {
      clearTimeout(room.warningTimer);
      room.warningTimer = null;
    }
    if (room.endTimer) {
      clearTimeout(room.endTimer);
      room.endTimer = null;
    }
    room.disconnectTimers.clear();
    room.pendingTimers.clear();
  }

  function endMeetingForRoom(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room) return;

    io.to(roomId).emit("meeting-ended", { reason });

    for (const memberId of [...room.activeMembers]) {
      const memberSocket = io.sockets.sockets.get(memberId);
      if (memberSocket) {
        memberSocket.leave(roomId);
        memberSocket.meetingRoomId = null;
      }
    }

    for (const memberId of [...room.pendingMembers]) {
      const memberSocket = io.sockets.sockets.get(memberId);
      if (memberSocket) {
        memberSocket.emit("meeting-ended", { reason });
        memberSocket.leave(roomId);
        memberSocket.meetingRoomId = null;
      }
    }

    clearRoomTimers(room);
    endedMeetings.add(roomId);
    rooms.delete(roomId);
  }

  function emitActivity(roomId, type, socketId, text) {
    const room = rooms.get(roomId);
    if (!room || !socketId || !text) return;

    const id = `${type}:${socketId}:${Date.now()}`;
    if (room.activityIds.has(id)) return;
    room.activityIds.add(id);
    if (room.activityIds.size > 300) {
      room.activityIds = new Set(Array.from(room.activityIds).slice(-200));
    }

    io.to(roomId).emit("meeting-activity", {
      id,
      type,
      socketId,
      message: text,
      timestamp: Date.now(),
    });
  }

  function getParticipantName(details) {
    return details?.displayName || details?.email || "User";
  }

  function scheduleMeetingDurationLimit(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.endTimer || MAX_MEETING_DURATION_MS <= 0) return;

    room.endsAt = room.createdAt + MAX_MEETING_DURATION_MS;
    const remainingMs = Math.max(0, room.endsAt - Date.now());
    const warningDelay = remainingMs - Math.max(0, MEETING_END_WARNING_MS);

    if (warningDelay <= 0) {
      io.to(roomId).emit("meeting-ending-soon", {
        reason: "Meeting duration limit reached",
        endsAt: room.endsAt,
        remainingMs,
      });
    } else {
      room.warningTimer = setTimeout(() => {
        io.to(roomId).emit("meeting-ending-soon", {
          reason: "Meeting duration limit reached",
          endsAt: room.endsAt,
          remainingMs: Math.max(0, room.endsAt - Date.now()),
        });
      }, warningDelay);
    }

    room.endTimer = setTimeout(() => {
      endMeetingForRoom(roomId, "Meeting duration limit reached");
      console.log(`[Socket] Meeting ${roomId} ended after reaching max duration`);
    }, remainingMs);
  }

  function scheduleWaitingLobbyTimeout(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room || WAITING_LOBBY_TIMEOUT_MS <= 0 || room.pendingTimers.has(socketId)) return;

    const timer = setTimeout(() => {
      const currentRoom = rooms.get(roomId);
      if (!currentRoom || !currentRoom.pendingMembers.has(socketId)) return;

      currentRoom.pendingTimers.delete(socketId);
      currentRoom.pendingMembers.delete(socketId);
      currentRoom.details.delete(socketId);

      const pendingSocket = io.sockets.sockets.get(socketId);
      if (pendingSocket) {
        pendingSocket.meetingRoomId = null;
        pendingSocket.emit("join-denied", {
          reason: "Request timed out. Please join again.",
        });
      }
      if (currentRoom.hostId) {
        io.to(currentRoom.hostId).emit("join-request-cancelled", { socketId });
      }
      if (currentRoom.activeMembers.size === 0 && currentRoom.pendingMembers.size === 0) {
        clearRoomTimers(currentRoom);
        rooms.delete(roomId);
      }
      console.log(`[Socket] Waiting room request timed out for ${socketId} in room ${roomId}`);
    }, WAITING_LOBBY_TIMEOUT_MS);

    room.pendingTimers.set(socketId, timer);
  }

  function handleUserLeaving(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.meetingRoomId === roomId) {
      socket.meetingRoomId = null;
    }

    const disconnectTimer = room.disconnectTimers.get(socket.id);
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      room.disconnectTimers.delete(socket.id);
    }

    // 1. Clean up pending user
    if (room.pendingMembers.has(socket.id)) {
      room.pendingMembers.delete(socket.id);
      clearPendingTimer(room, socket.id);
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
        room.activeScreenSharerId =
          room.activeScreenSharerId === socket.id ? null : room.activeScreenSharerId;
        socket.broadcast.to(roomId).emit("screen-share-stopped", {
          senderId: socket.id,
        });
        emitActivity(
          roomId,
          "screen-share-stopped",
          socket.id,
          `${getParticipantName(leavingDetails)} stopped presenting`
        );
      }

      room.activeMembers.delete(socket.id);
      room.details.delete(socket.id);
      socket.leave(roomId);

      io.to(roomId).emit("participant-left", { socketId: socket.id });
      emitActivity(
        roomId,
        "participant-left",
        socket.id,
        `${getParticipantName(leavingDetails)} left`
      );
      console.log(`[Socket] User ${socket.id} left active room ${roomId}`);

      // 3. Host leaves; host authority returns only when the meeting creator rejoins.
      if (room.hostId === socket.id) {
        room.hostId = null;
      }
    }

    // 4. Delete room if completely empty
    if (room.activeMembers.size === 0 && room.pendingMembers.size === 0) {
      clearRoomTimers(room);
      rooms.delete(roomId);
      console.log(`[Socket] Room ${roomId} completely deleted`);
    }
  }

  function scheduleDisconnectCleanup(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (!room.activeMembers.has(socket.id) && !room.pendingMembers.has(socket.id)) return;
    if (room.disconnectTimers.has(socket.id)) return;

    const timer = setTimeout(() => {
      const currentRoom = rooms.get(roomId);
      if (!currentRoom) return;
      currentRoom.disconnectTimers.delete(socket.id);
      handleUserLeaving(socket, roomId);
    }, 10_000);

    room.disconnectTimers.set(socket.id, timer);
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

  function findActiveSocketForUser(room, userId, exceptSocketId) {
    if (!userId) return null;
    return Array.from(room.activeMembers).find((memberSocketId) => {
      if (memberSocketId === exceptSocketId) return false;
      return room.details.get(memberSocketId)?.userId === userId;
    }) || null;
  }

  function findPendingSocketForUser(room, userId, exceptSocketId) {
    if (!userId) return null;
    return Array.from(room.pendingMembers).find((memberSocketId) => {
      if (memberSocketId === exceptSocketId) return false;
      return room.details.get(memberSocketId)?.userId === userId;
    }) || null;
  }

  function findActiveSocketForClient(room, clientId, exceptSocketId) {
    if (!clientId) return null;
    return Array.from(room.activeMembers).find((memberSocketId) => {
      if (memberSocketId === exceptSocketId) return false;
      return room.details.get(memberSocketId)?.clientId === clientId;
    }) || null;
  }

  function findPendingSocketForClient(room, clientId, exceptSocketId) {
    if (!clientId) return null;
    return Array.from(room.pendingMembers).find((memberSocketId) => {
      if (memberSocketId === exceptSocketId) return false;
      return room.details.get(memberSocketId)?.clientId === clientId;
    }) || null;
  }

  function isSocketConnected(socketId) {
    return Boolean(io.sockets.sockets.get(socketId)?.connected);
  }

  function removeDisconnectedSession(socketId, roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.activeMembers.has(socketId) || isSocketConnected(socketId)) return null;

    const disconnectTimer = room.disconnectTimers.get(socketId);
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      room.disconnectTimers.delete(socketId);
    }

    const details = room.details.get(socketId);
    if (details?.isScreenSharing) {
      room.activeScreenSharerId =
        room.activeScreenSharerId === socketId ? null : room.activeScreenSharerId;
      io.to(roomId).emit("screen-share-stopped", {
        senderId: socketId,
      });
      emitActivity(
        roomId,
        "screen-share-stopped",
        socketId,
        `${getParticipantName(details)} stopped presenting`
      );
    }

    room.activeMembers.delete(socketId);
    room.details.delete(socketId);
    if (room.hostId === socketId) {
      room.hostId = null;
    }

    return details;
  }

  function removeDisconnectedPendingSession(socketId, roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.pendingMembers.has(socketId) || isSocketConnected(socketId)) return null;

    const disconnectTimer = room.disconnectTimers.get(socketId);
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      room.disconnectTimers.delete(socketId);
    }

    const details = room.details.get(socketId);
    clearPendingTimer(room, socketId);
    room.pendingMembers.delete(socketId);
    room.details.delete(socketId);
    if (room.hostId) {
      io.to(room.hostId).emit("join-request-cancelled", { socketId });
    }

    return details;
  }

  function removeSwitchedSession(socketToRemove, roomId) {
    const room = rooms.get(roomId);
    if (!room || !socketToRemove || !room.activeMembers.has(socketToRemove.id)) return null;

    const details = room.details.get(socketToRemove.id);
    if (details?.participantRecordId) {
      prisma.meetingParticipant
        .update({
          where: { id: details.participantRecordId },
          data: { leftAt: new Date() },
        })
        .catch((err) =>
          console.warn("[Socket] participant switch persistence failed:", err.message)
        );
    }

    if (details?.isScreenSharing) {
      room.activeScreenSharerId =
        room.activeScreenSharerId === socketToRemove.id ? null : room.activeScreenSharerId;
      socketToRemove.broadcast.to(roomId).emit("screen-share-stopped", {
        senderId: socketToRemove.id,
      });
      emitActivity(
        roomId,
        "screen-share-stopped",
        socketToRemove.id,
        `${getParticipantName(details)} stopped presenting`
      );
    }

    room.activeMembers.delete(socketToRemove.id);
    room.details.delete(socketToRemove.id);
    socketToRemove.leave(roomId);
    socketToRemove.emit("force-switched", { roomId });

    return details;
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
    socket.on("join-request", async ({ roomId: rawRoomId, token, displayName, isMicOn, isCameraOn, clientId }) => {
      const roomId = normalizeRoomId(rawRoomId);
      if (!roomId) return;
      socket.meetingRoomId = roomId;

      if (endedMeetings.has(roomId)) {
        socket.emit("meeting-ended", {
          reason: "Host ended the meeting",
        });
        return;
      }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, createRoomState());
        scheduleMeetingDurationLimit(roomId);
      }

      const room = rooms.get(roomId);
      scheduleMeetingDurationLimit(roomId);

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
        clientId: clientId || null,
        displayName: resolvedDisplayName,
        email,
        image,
        isMicOn: isMicOn !== false,
        isCameraOn: isCameraOn !== false,
        isHandRaised: false,
        isScreenSharing: false,
        isHost: isMeetingCreator,
      };

      const existingActiveSocketId = findActiveSocketForUser(room, authenticatedUserId, socket.id);
      let replacedSocketId = null;
      if (existingActiveSocketId) {
        if (isSocketConnected(existingActiveSocketId)) {
          socket.emit("already-in-meeting", { roomId });
          return;
        }
        if (removeDisconnectedSession(existingActiveSocketId, roomId)) {
          replacedSocketId = existingActiveSocketId;
        }
      }

      const existingActiveClientSocketId = findActiveSocketForClient(room, clientId, socket.id);
      if (!existingActiveSocketId && existingActiveClientSocketId) {
        if (isSocketConnected(existingActiveClientSocketId)) {
          socket.emit("already-in-meeting", { roomId });
          return;
        }
        if (removeDisconnectedSession(existingActiveClientSocketId, roomId)) {
          replacedSocketId = existingActiveClientSocketId;
        }
      }

      const existingPendingSocketId = findPendingSocketForUser(room, authenticatedUserId, socket.id);
      if (existingPendingSocketId) {
        if (isSocketConnected(existingPendingSocketId)) {
          socket.emit("already-in-meeting", { roomId });
          return;
        }
        removeDisconnectedPendingSession(existingPendingSocketId, roomId);
      }

      const existingPendingClientSocketId = findPendingSocketForClient(room, clientId, socket.id);
      if (!existingPendingSocketId && existingPendingClientSocketId) {
        if (isSocketConnected(existingPendingClientSocketId)) {
          socket.emit("already-in-meeting", { roomId });
          return;
        }
        removeDisconnectedPendingSession(existingPendingClientSocketId, roomId);
      }

      // Limit room size to 15 participants
      if (room.activeMembers.size >= 15) {
        socket.emit("join-denied", { reason: "Meeting is full" });
        return;
      }

      room.details.set(socket.id, memberDetail);

      if (
        isMeetingCreator ||
        (authenticatedUserId && room.admittedUserIds.has(authenticatedUserId)) ||
        (clientId && room.admittedClientIds.has(clientId))
      ) {
        // Immediate approval only for the persisted meeting creator.
        room.activeMembers.add(socket.id);
        if (isMeetingCreator) {
          room.hostId = socket.id;
        }
        if (authenticatedUserId) {
          room.admittedUserIds.add(authenticatedUserId);
        }
        if (clientId) {
          room.admittedClientIds.add(clientId);
        }
        socket.join(roomId);

        const otherActiveMembers = Array.from(room.activeMembers).filter(
          (id) => id !== socket.id
        );
        const membersList = otherActiveMembers
          .map((id) => room.details.get(id))
          .filter(Boolean);

        console.log(`[Socket] ${isMeetingCreator ? "Meeting creator" : "Admitted participant"} joined room ${roomId}. Socket: ${socket.id}`);
        socket.emit("join-approved", {
          isHost: isMeetingCreator,
          roomId,
          members: membersList,
          chatHistory: room.messages || [],
        });
        if (replacedSocketId) {
          socket.broadcast.to(roomId).emit("participant-switched", {
            previousSocketId: replacedSocketId,
            member: memberDetail,
          });
        } else {
          socket.broadcast.to(roomId).emit("participant-joined", memberDetail);
          emitActivity(
            roomId,
            "participant-joined",
            socket.id,
            `${getParticipantName(memberDetail)} joined`
          );
        }
        void persistApprovedParticipant(roomId, socket.id);
        if (isMeetingCreator) {
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
        }
      } else {
        // Waiting room flow for every non-host participant.
        room.pendingMembers.add(socket.id);
        scheduleWaitingLobbyTimeout(roomId, socket.id);
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

    socket.on("switch-here", async ({ roomId: rawRoomId, token, displayName, isMicOn, isCameraOn, clientId }) => {
      const roomId = normalizeRoomId(rawRoomId);
      if (!roomId) return;
      socket.meetingRoomId = roomId;

      const room = rooms.get(roomId);
      if (!room) return;

      if (endedMeetings.has(roomId)) {
        socket.emit("meeting-ended", {
          reason: "Host ended the meeting",
        });
        return;
      }

      const meeting = await prisma.meeting.findUnique({
        where: { meetingCode: roomId },
        select: { hostId: true, expiresAt: true },
      });

      if (!meeting || meeting.expiresAt < new Date()) return;

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
          console.error("[Socket] switch token verification failed:", err.message);
        }
      }

      const existingActiveSocketId =
        findActiveSocketForUser(room, authenticatedUserId, socket.id) ||
        findActiveSocketForClient(room, clientId, socket.id);
      if (!existingActiveSocketId) {
        socket.emit("join-denied", { reason: "The other session is no longer active" });
        return;
      }

      const existingSocket = io.sockets.sockets.get(existingActiveSocketId);
      const previousDetails = removeSwitchedSession(existingSocket, roomId);
      if (!previousDetails) return;

      const isHostAfterSwitch = Boolean(
        previousDetails.isHost || (authenticatedUserId && authenticatedUserId === meeting.hostId)
      );
      const memberDetail = {
        socketId: socket.id,
        userId: authenticatedUserId,
        clientId: clientId || previousDetails.clientId || null,
        displayName: resolvedDisplayName || previousDetails.displayName || "Guest",
        email,
        image,
        isMicOn: isMicOn !== false,
        isCameraOn: isCameraOn !== false,
        isHandRaised: previousDetails.isHandRaised || false,
        isScreenSharing: false,
        isHost: isHostAfterSwitch,
      };

      room.pendingMembers.delete(socket.id);
      room.details.set(socket.id, memberDetail);
      room.activeMembers.add(socket.id);
      if (isHostAfterSwitch) {
        room.hostId = socket.id;
      }
      socket.join(roomId);

      const membersList = Array.from(room.activeMembers)
        .filter((id) => id !== socket.id)
        .map((id) => room.details.get(id))
        .filter(Boolean);

      socket.emit("join-approved", {
        isHost: isHostAfterSwitch,
        roomId,
        members: membersList,
        chatHistory: room.messages || [],
      });
      socket.broadcast.to(roomId).emit("participant-switched", {
        previousSocketId: existingActiveSocketId,
        member: memberDetail,
      });
      void persistApprovedParticipant(roomId, socket.id);
      if (isHostAfterSwitch) {
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
      }
    });

    

    // Host approves pending participant
    socket.on("approve-join", ({ roomId, socketId }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id) return;

      if (room.pendingMembers.has(socketId)) {
        room.pendingMembers.delete(socketId);
        clearPendingTimer(room, socketId);
        room.activeMembers.add(socketId);

        const details = room.details.get(socketId);
        if (!details) return;
        details.isHost = false;
        if (details.userId) {
          room.admittedUserIds.add(details.userId);
        }
        if (details.clientId) {
          room.admittedClientIds.add(details.clientId);
        }

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
        emitActivity(
          roomId,
          "participant-joined",
          socketId,
          `${getParticipantName(details)} joined`
        );
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
        clearPendingTimer(room, socketId);
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
        const details = room.details.get(socketId);
        if (details?.userId) {
          room.admittedUserIds.delete(details.userId);
        }
        if (details?.clientId) {
          room.admittedClientIds.delete(details.clientId);
        }
        if (details?.isScreenSharing) {
          room.activeScreenSharerId =
            room.activeScreenSharerId === socketId ? null : room.activeScreenSharerId;
          io.to(roomId).emit("screen-share-stopped", { senderId: socketId });
          emitActivity(
            roomId,
            "screen-share-stopped",
            socketId,
            `${getParticipantName(details)} stopped presenting`
          );
        }
        room.activeMembers.delete(socketId);
        room.details.delete(socketId);

        const kickedSocket = io.sockets.sockets.get(socketId);
        if (kickedSocket) {
          kickedSocket.leave(roomId);
        }

        io.to(socketId).emit("removed-from-meeting");
        io.to(roomId).emit("participant-left", { socketId });
        emitActivity(
          roomId,
          "participant-removed",
          socketId,
          `${getParticipantName(details)} was removed`
        );
        console.log(`[Socket] Host ${socket.id} removed ${socketId} in room ${roomId}`);
      }
    });

    // Hand raise updates
    // Host ends meeting for all participants
    socket.on("end-meeting-for-all", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id) return;

      endMeetingForRoom(roomId, "Host ended the meeting");
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

      const details = room.details.get(socket.id);
      const previousPresenterId =
        room.activeScreenSharerId && room.activeScreenSharerId !== socket.id
          ? room.activeScreenSharerId
          : null;

      if (previousPresenterId) {
        const previousDetails = room.details.get(previousPresenterId);
        if (previousDetails) {
          previousDetails.isScreenSharing = false;
        }
        io.to(previousPresenterId).emit("screen-share-force-stopped", {
          reason: "Your presentation was stopped because another participant started presenting.",
          newPresenterId: socket.id,
        });
        io.to(roomId).emit("screen-share-stopped", {
          senderId: previousPresenterId,
        });
        emitActivity(
          roomId,
          "screen-share-stopped",
          previousPresenterId,
          `${getParticipantName(previousDetails)} stopped presenting`
        );
      }

      details.isScreenSharing = true;
      room.activeScreenSharerId = socket.id;
      io.to(roomId).emit("screen-share-started", {
        senderId: socket.id,
      });
      emitActivity(
        roomId,
        "screen-share-started",
        socket.id,
        `${getParticipantName(details)} started presenting`
      );
    });

    socket.on("screen-share-stopped", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || !room.details.has(socket.id)) return;

      const details = room.details.get(socket.id);
      details.isScreenSharing = false;
      if (room.activeScreenSharerId === socket.id) {
        room.activeScreenSharerId = null;
      }
      io.to(roomId).emit("screen-share-stopped", {
        senderId: socket.id,
      });
      emitActivity(
        roomId,
        "screen-share-stopped",
        socket.id,
        `${getParticipantName(details)} stopped presenting`
      );
    });

    socket.on("leave-room", ({ roomId }) => {
      if (!roomId) return;
      handleUserLeaving(socket, roomId);
    });

    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;
        scheduleDisconnectCleanup(socket, roomId);
      }
      if (socket.meetingRoomId) {
        scheduleDisconnectCleanup(socket, socket.meetingRoomId);
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
