const { Server } = require("socket.io");

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

function normalizeRoomId(payload) {
  if (typeof payload === "string") return payload.trim();
  return payload?.roomId || payload?.meetingCode || null;
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
      room.activeMembers.delete(socket.id);
      room.details.delete(socket.id);
      socket.leave(roomId);

      io.to(roomId).emit("participant-left", { socketId: socket.id });
      console.log(`[Socket] User ${socket.id} left active room ${roomId}`);

      // 3. Host Promotion/Re-assignment
      if (room.hostId === socket.id) {
        if (room.activeMembers.size > 0) {
          const newHostId = Array.from(room.activeMembers)[0];
          room.hostId = newHostId;
          const details = room.details.get(newHostId);
          if (details) {
            details.isHost = true;
          }
          io.to(roomId).emit("host-changed", {
            hostId: newHostId,
            hostDetails: details,
          });
          console.log(`[Socket] Host promoted to ${newHostId} in room ${roomId}`);
        } else {
          room.hostId = null;
        }
      }
    }

    // 4. Delete room if completely empty
    if (room.activeMembers.size === 0 && room.pendingMembers.size === 0) {
      rooms.delete(roomId);
      console.log(`[Socket] Room ${roomId} completely deleted`);
    }
  }

  io.on("connection", (socket) => {
    console.log(new Date().toISOString(), "Socket connected:", socket.id);

    // Dynamic join request / direct enter if first
    socket.on("join-request", ({ roomId: rawRoomId, displayName, email, image, isMicOn, isCameraOn }) => {
      const roomId = normalizeRoomId(rawRoomId);
      if (!roomId) return;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          hostId: null,
          activeMembers: new Set(),
          pendingMembers: new Set(),
          details: new Map(),
        });
      }

      const room = rooms.get(roomId);

      // Limit room size to 10 participants
      if (room.activeMembers.size >= 10) {
        socket.emit("join-denied", { reason: "Meeting is full" });
        return;
      }

      const isFirst = room.activeMembers.size === 0;
      const memberDetail = {
        socketId: socket.id,
        displayName: displayName || email || "Guest",
        email: email || "",
        image: image || "",
        isMicOn: isMicOn !== false,
        isCameraOn: isCameraOn !== false,
        isScreenSharing: false,
        isHost: isFirst,
      };

      room.details.set(socket.id, memberDetail);

      if (isFirst) {
        // Immediate approval for the host (first person)
        room.activeMembers.add(socket.id);
        room.hostId = socket.id;
        socket.join(roomId);

        console.log(`[Socket] Room ${roomId} created. Host: ${socket.id}`);
        socket.emit("join-approved", {
          isHost: true,
          roomId,
          members: [],
        });
      } else {
        // Waiting room flow for all subsequent participants
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

        // Fetch other active members details to supply to approved user
        const otherActiveMembers = Array.from(room.activeMembers).filter(
          (id) => id !== socketId
        );
        const membersList = otherActiveMembers.map((id) => room.details.get(id));

        // approved socket joins room
        const approvedSocket = io.sockets.sockets.get(socketId);
        if (approvedSocket) {
          approvedSocket.join(roomId);
        }

        io.to(socketId).emit("join-approved", {
          isHost: false,
          roomId,
          members: membersList,
        });

        // Notify active members in room
        socket.broadcast.to(roomId).emit("participant-joined", details);
        console.log(`[Socket] Host ${socket.id} approved ${socketId} in room ${roomId}`);
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
        displayName: details.displayName,
        email: details.email,
        image: details.image,
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

    // Chat room messaging
    socket.on("send-message", ({ roomId, message, senderName }) => {
      if (!roomId || !message) return;
      io.to(roomId).emit("receive-message", {
        senderId: socket.id,
        senderName: senderName || "Anonymous",
        message,
        timestamp: Date.now(),
      });
    });

    // Real-time emoji reaction syncing
    socket.on("emoji-reaction", ({ roomId, emoji }) => {
      if (!roomId || !emoji) return;
      socket.broadcast.to(roomId).emit("emoji-reaction", {
        senderId: socket.id,
        emoji,
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
    });
  });
}

module.exports = setupSocket;
