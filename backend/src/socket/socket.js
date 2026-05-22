const { Server } = require("socket.io");

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (meetingCode) => {
      if (!meetingCode) return;

      socket.join(meetingCode);
      console.log(`User ${socket.id} joined room ${meetingCode}`);
      socket.to(meetingCode).emit("user-joined", {
        socketId: socket.id,
      });
    });

    socket.on("offer", ({ roomId, offer }) => {
      if (!roomId || !offer) return;
      socket.to(roomId).emit("offer", { offer, senderId: socket.id });
    });

    socket.on("answer", ({ roomId, answer }) => {
      if (!roomId || !answer) return;
      socket.to(roomId).emit("answer", { answer, senderId: socket.id });
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
      if (!roomId || !candidate) return;
      socket.to(roomId).emit("ice-candidate", {
        candidate,
        senderId: socket.id,
      });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });
}

module.exports = setupSocket;