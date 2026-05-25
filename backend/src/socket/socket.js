const { Server } = require("socket.io");

/** roomId -> Set<socketId> */
const roomMembers = new Map();

function normalizeRoomId(payload) {
  if (typeof payload === "string") return payload.trim();
  return payload?.roomId || payload?.meetingCode || null;
}

function getRoomMembers(roomId) {
  if (!roomMembers.has(roomId)) {
    roomMembers.set(roomId, new Set());
  }
  return roomMembers.get(roomId);
}

function addMember(roomId, socketId) {
  getRoomMembers(roomId).add(socketId);
}

function removeMember(roomId, socketId) {
  const set = roomMembers.get(roomId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) roomMembers.delete(roomId);
}

function setupSocket(server) {
  const allowedOrigins = new Set(
    [
      process.env.FRONTEND_URL ||
        "https://google-meet-frontend-theta.vercel.app",
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

  io.on("connection", (socket) => {
    console.log(new Date().toISOString(), "Socket connected:", socket.id);

    socket.on("join-room", (payload) => {
      const roomId = normalizeRoomId(payload);
      if (!roomId) return;

      const membersBeforeJoin = Array.from(getRoomMembers(roomId)).filter(
        (id) => id !== socket.id
      );

      socket.join(roomId);
      addMember(roomId, socket.id);

      console.log(
        new Date().toISOString(),
        `join-room: ${socket.id} -> ${roomId}, existing:`,
        membersBeforeJoin
      );

      // Only to the joining client
      socket.emit("existing-members", { members: membersBeforeJoin });

      // To everyone else in the room (not sender)
      socket.broadcast.to(roomId).emit("user-joined", { socketId: socket.id });
    });

    socket.on("offer", ({ roomId, offer }) => {
      if (!roomId || !offer) return;
      socket.broadcast.to(roomId).emit("offer", {
        offer,
        senderId: socket.id,
        roomId,
      });
    });

    socket.on("answer", ({ roomId, answer }) => {
      if (!roomId || !answer) return;
      socket.broadcast.to(roomId).emit("answer", {
        answer,
        senderId: socket.id,
        roomId,
      });
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
      if (!roomId || !candidate) return;
      socket.broadcast.to(roomId).emit("ice-candidate", {
        candidate,
        senderId: socket.id,
        roomId,
      });
    });

    socket.on("leave-room", (payload) => {
      const roomId = normalizeRoomId(payload);
      if (!roomId) return;

      removeMember(roomId, socket.id);
      socket.leave(roomId);
      socket.broadcast.to(roomId).emit("user-left", { socketId: socket.id });
      console.log(
        new Date().toISOString(),
        `leave-room: ${socket.id} <- ${roomId}`
      );
    });

    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;
        removeMember(roomId, socket.id);
        socket.broadcast.to(roomId).emit("user-left", { socketId: socket.id });
      }
    });

    socket.on("disconnect", () => {
      console.log(new Date().toISOString(), "Socket disconnected:", socket.id);
    });
  });
}

module.exports = setupSocket;
