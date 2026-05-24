const { Server } = require("socket.io");

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(new Date().toISOString(), "User connected:", socket.id);

    // Track members per room for targeted signaling
    const roomMembers = new Map(); // roomId -> Set(socketId)

    function addMember(roomId, sid) {
      if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
      roomMembers.get(roomId).add(sid);
    }

    function removeMember(roomId, sid) {
      if (!roomMembers.has(roomId)) return;
      const set = roomMembers.get(roomId);
      set.delete(sid);
      if (set.size === 0) roomMembers.delete(roomId);
    }

    socket.on("join-room", (meetingCode) => {
      if (!meetingCode) return;

      socket.join(meetingCode);
      addMember(meetingCode, socket.id);
      const others = Array.from((roomMembers.get(meetingCode) || new Set())).filter((id) => id !== socket.id);
      console.log(new Date().toISOString(), `User ${socket.id} joined room ${meetingCode}. Others:`, others);

      // Send existing members to the joining socket so it can initiate offers to them
      socket.emit("existing-members", { members: others });

      // Notify others that a new user joined
      socket.broadcast.to(meetingCode).emit("user-joined", {
        socketId: socket.id,
      });
    });

    // Offers/answers/ice-candidates should target a specific socketId when possible
    socket.on("offer", ({ roomId, offer, targetId }) => {
      if (!roomId || !offer) return;
      console.log(new Date().toISOString(), `Offer from ${socket.id} to ${targetId || roomId}`);
      if (targetId) {
        io.to(targetId).emit("offer", { offer, senderId: socket.id });
      } else {
        socket.broadcast.to(roomId).emit("offer", { offer, senderId: socket.id });
      }
    });

    socket.on("answer", ({ roomId, answer, targetId }) => {
      if (!roomId || !answer) return;
      console.log(new Date().toISOString(), `Answer from ${socket.id} to ${targetId || roomId}`);
      if (targetId) {
        io.to(targetId).emit("answer", { answer, senderId: socket.id });
      } else {
        socket.broadcast.to(roomId).emit("answer", { answer, senderId: socket.id });
      }
    });

    socket.on("ice-candidate", ({ roomId, candidate, targetId }) => {
      if (!roomId || !candidate) return;
      console.log(new Date().toISOString(), `ICE candidate from ${socket.id} to ${targetId || roomId}`);
      if (targetId) {
        io.to(targetId).emit("ice-candidate", { candidate, senderId: socket.id });
      } else {
        socket.broadcast.to(roomId).emit("ice-candidate", { candidate, senderId: socket.id });
      }
    });

    // Allow clients to request server-provided ICE configuration via socket (optional)
    socket.on("request-ice-servers", async (callback) => {
      try {
        // prefer environment-provided JSON
        if (process.env.ICE_SERVERS_JSON) {
          return callback({ iceServers: JSON.parse(process.env.ICE_SERVERS_JSON) });
        }

        const iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
        if (process.env.TURN_URL) {
          const turn = { urls: process.env.TURN_URL };
          if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
          if (process.env.TURN_PASSWORD) turn.credential = process.env.TURN_PASSWORD;
          iceServers.push(turn);
        }

        if (process.env.TURN_URLS) {
          const urls = process.env.TURN_URLS.split(";").map((u) => u.trim()).filter(Boolean);
          urls.forEach((u) => iceServers.push({ urls: u, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD }));
        }

        return callback({ iceServers });
      } catch (err) {
        console.error("request-ice-servers failed:", err.message);
        return callback({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
      }
    });

    socket.on("disconnecting", () => {
      const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
      rooms.forEach((roomId) => {
        removeMember(roomId, socket.id);
        socket.broadcast.to(roomId).emit("user-left", { socketId: socket.id });
      });
    });

    socket.on("disconnect", () => {
      console.log(new Date().toISOString(), "User disconnected:", socket.id);
    });
  });
}

module.exports = setupSocket;