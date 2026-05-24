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

    socket.on("join-room", (meetingCode) => {
      if (!meetingCode) return;

      socket.join(meetingCode);
      console.log(new Date().toISOString(), `User ${socket.id} joined room ${meetingCode}`);
      socket.to(meetingCode).emit("user-joined", {
        socketId: socket.id,
      });
    });

    socket.on("offer", ({ roomId, offer }) => {
      if (!roomId || !offer) return;
      console.log(new Date().toISOString(), `Offer from ${socket.id} to room ${roomId}`);
      socket.to(roomId).emit("offer", { offer, senderId: socket.id });
    });

    socket.on("answer", ({ roomId, answer }) => {
      if (!roomId || !answer) return;
      console.log(new Date().toISOString(), `Answer from ${socket.id} to room ${roomId}`);
      socket.to(roomId).emit("answer", { answer, senderId: socket.id });
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
      if (!roomId || !candidate) return;
      console.log(new Date().toISOString(), `ICE candidate from ${socket.id} to room ${roomId}`);
      socket.to(roomId).emit("ice-candidate", {
        candidate,
        senderId: socket.id,
      });
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

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });
}

module.exports = setupSocket;