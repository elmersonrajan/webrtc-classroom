// server/index.js
// This server does ONLY two things:
// 1. Serves the frontend files (HTML/CSS/JS) from the /public folder
// 2. Relays small "signaling" messages between browsers using Socket.IO
//    (it never sees or touches actual video/audio - that travels
//    directly between browsers via WebRTC)

const express = require('express');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

// HTTPS is required for camera/mic access from any device that isn't
// "localhost" itself (e.g. your phone on the same WiFi). We use a
// self-signed certificate here - fine for local demos, browsers will
// show a one-time "not secure" warning that you click through.
const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'cert.pem')),
  },
  app
);

const io = new Server(server);

// Serve everything inside /public as static files (index.html, css, js)
app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory room state. No database needed for the demo.
// Shape: { roomId: { participants: { socketId: { name, role } } } }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // A browser wants to join a classroom session
  socket.on('join-room', ({ roomId, name, role }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.data.role = role;

    if (!rooms[roomId]) rooms[roomId] = { participants: {} };

    // Tell the new person who is already in the room,
    // so they know who to connect their WebRTC peer connections to
    const existing = Object.entries(rooms[roomId].participants).map(([id, p]) => ({
      id, name: p.name, role: p.role
    }));
    socket.emit('existing-participants', existing);

    // Add the new participant to room state
    rooms[roomId].participants[socket.id] = { name, role };

    // Tell everyone else a new participant joined
    socket.to(roomId).emit('participant-joined', { id: socket.id, name, role });

    console.log(`[join] ${name} (${role}) -> room ${roomId}`);
  });

  // --- WebRTC signaling relay ---
  // These messages are just JSON blobs (SDP offers/answers, ICE candidates).
  // The server blindly forwards them to the intended recipient.
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // --- Chat / QA messages ---
  socket.on('chat-message', ({ roomId, message }) => {
    const name = socket.data.name || 'Someone';
    io.to(roomId).emit('chat-message', { name, message, time: Date.now() });
  });

  // --- Whiteboard drawing sync ---
  socket.on('draw', (strokeData) => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('draw', strokeData);
  });

  socket.on('clear-board', () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('clear-board');
  });

  // --- Instructor controls ---
  socket.on('mute-participant', ({ targetId }) => {
    io.to(targetId).emit('force-mute');
  });

  // --- Cleanup on disconnect ---
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].participants[socket.id];
      socket.to(roomId).emit('participant-left', { id: socket.id });
      if (Object.keys(rooms[roomId].participants).length === 0) {
        delete rooms[roomId];
      }
    }
    console.log(`[disconnect] ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Classroom server running:`);
  console.log(`  - On this computer:  https://localhost:${PORT}`);
  console.log(`  - On your phone/other devices (same WiFi): https://<this-computer's-local-IP>:${PORT}`);
  console.log(`    (find your local IP with 'ipconfig' on Windows or 'ifconfig'/'ip addr' on Mac/Linux)`);
});