module.exports = (io) => {
  io.on("connection", (socket) => {
    console.log("Connected", socket.id);

    socket.on("join-room", ({ roomId }) => {
      socket.join(roomId);

      socket
        .to(roomId)
        .emit("user-joined", {
          socketId: socket.id,
        });
    });
  });
};