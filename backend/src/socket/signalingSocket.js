module.exports = (io) => {
  io.on("connection", (socket) => {
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
  });
};