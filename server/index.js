// server/index.js
// SFU architecture using mediasoup: every browser sends its media to THIS
// server once, and the server forwards copies to whoever needs them. This
// replaces the old mesh setup, where every browser connected directly to
// every other browser (which didn't scale past a handful of people).
//
// The overall shape is the same as before - Express serves the frontend,
// Socket.IO carries small JSON signaling messages - but now those messages
// talk to mediasoup on the server instead of directly between browsers.

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'cert.pem')),
  },
  app
);

const io = new Server(server);
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================
// CONFIG - things you may need to change for your network
// ============================================================

// If phones/other devices on your WiFi can't get audio/video (but the
// signaling/whiteboard/chat all work), this is almost always the fix:
// set this to your computer's LAN IP (the same one you use to open the
// site from your phone, e.g. 192.168.1.42). Find it with `ipconfig`
// (Windows) or `ifconfig`/`ip addr` (Mac/Linux).
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || null; // null = auto (works on localhost only)

// mediasoup sends actual media over these UDP ports - make sure your
// firewall allows this range, not just the HTTPS port 3000.
const RTC_MIN_PORT = 10000;
const RTC_MAX_PORT = 10100;

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
];

// ============================================================
// mediasoup worker (one per server - handles the actual media processing)
// ============================================================

let worker;

async function createWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });
  console.log(`mediasoup worker started (pid ${worker.pid})`);
  worker.on('died', () => {
    console.error('mediasoup worker died unexpectedly - restart the server');
    process.exit(1);
  });
}

// ============================================================
// Room state
// ============================================================
// rooms[roomId] = {
//   router,
//   participants: { socketId: { name, role } }
//   transports: { socketId: { send, recv } }
//   producers: { producerId: { socketId, kind, appData } }
//   consumers: { socketId: { consumerId: consumer } }
// }
const rooms = {};

async function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    rooms[roomId] = {
      router,
      participants: {},
      transports: {},
      producers: {},
      consumers: {},
    };
  }
  return rooms[roomId];
}

function transportOptions() {
  return {
    listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  };
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ---- Room join (same idea as before) ----
  socket.on('join-room', async ({ roomId, name, role }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.data.role = role;

    const room = await getOrCreateRoom(roomId);

    const existing = Object.entries(room.participants).map(([id, p]) => ({
      id, name: p.name, role: p.role
    }));
    socket.emit('existing-participants', existing);

    room.participants[socket.id] = { name, role };
    room.transports[socket.id] = {};
    room.consumers[socket.id] = {};

    socket.to(roomId).emit('participant-joined', { id: socket.id, name, role });

    // Tell the new arrival about every producer already active in the room,
    // so they can start consuming (watching/listening to) them right away.
    const existingProducers = Object.entries(room.producers).map(([producerId, p]) => ({
      producerId, socketId: p.socketId, kind: p.kind, appData: p.appData,
    }));
    socket.emit('existing-producers', existingProducers);

    console.log(`[join] ${name} (${role}) -> room ${roomId}`);
  });

  // ---- mediasoup handshake ----

  socket.on('get-router-rtp-capabilities', async ({ roomId }, callback) => {
    const room = await getOrCreateRoom(roomId);
    callback({ rtpCapabilities: room.router.rtpCapabilities });
  });

  socket.on('create-transport', async ({ roomId, direction }, callback) => {
    const room = await getOrCreateRoom(roomId);
    const transport = await room.router.createWebRtcTransport(transportOptions());

    room.transports[socket.id] = room.transports[socket.id] || {};
    room.transports[socket.id][direction] = transport;

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  });

  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
    const room = rooms[roomId];
    const transport = findTransport(room, socket.id, transportId);
    if (!transport) return callback({ error: 'transport not found' });
    await transport.connect({ dtlsParameters });
    callback({ connected: true });
  });

  socket.on('produce', async ({ roomId, transportId, kind, rtpParameters, appData }, callback) => {
    const room = rooms[roomId];
    const transport = findTransport(room, socket.id, transportId);
    if (!transport) return callback({ error: 'transport not found' });

    const producer = await transport.produce({ kind, rtpParameters, appData });
    room.producers[producer.id] = { producer, socketId: socket.id, kind, appData };

    producer.on('transportclose', () => {
      delete room.producers[producer.id];
    });

    // Let everyone else in the room know a new stream is available to watch/listen to
    socket.to(roomId).emit('new-producer', {
      producerId: producer.id,
      socketId: socket.id,
      name: room.participants[socket.id]?.name,
      role: room.participants[socket.id]?.role,
      kind,
      appData,
    });

    callback({ id: producer.id });
  });

  socket.on('close-producer', async ({ roomId, producerId }) => {
    const room = rooms[roomId];
    const entry = room?.producers[producerId];
    if (!entry) return;
    entry.producer.close();
    delete room.producers[producerId];
    io.to(roomId).emit('producer-closed', { producerId });
  });

  socket.on('consume', async ({ roomId, producerId, rtpCapabilities }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback({ error: 'room not found yet - try again in a moment' });
    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      return callback({ error: 'cannot consume' });
    }

    const recvTransport = room.transports[socket.id]?.recv;
    if (!recvTransport) return callback({ error: 'no recv transport' });

    const consumer = await recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // client will tell us to resume once it's ready to render
    });

    // room.consumers[socket.id] is normally set up during join-room, but that
    // handler is async - a fast client can have this request arrive before
    // it finishes. Create it here too instead of assuming it already exists.
    if (!room.consumers[socket.id]) room.consumers[socket.id] = {};
    room.consumers[socket.id][consumer.id] = consumer;

    consumer.on('transportclose', () => { delete room.consumers[socket.id]?.[consumer.id]; });
    consumer.on('producerclose', () => {
      delete room.consumers[socket.id]?.[consumer.id];
      socket.emit('producer-closed', { producerId });
    });

    callback({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  });

  socket.on('resume-consumer', async ({ roomId, consumerId }, callback) => {
    const room = rooms[roomId];
    const consumer = room?.consumers[socket.id]?.[consumerId];
    if (consumer) await consumer.resume();
    if (callback) callback({ resumed: true });
  });

  // ---- Chat / QA (unchanged) ----
  socket.on('chat-message', ({ roomId, message }) => {
    const name = socket.data.name || 'Someone';
    io.to(roomId).emit('chat-message', { name, message, time: Date.now() });
  });

  // ---- Whiteboard drawing sync (unchanged) - instructor only ----
  socket.on('draw', (strokeData) => {
    const roomId = socket.data.roomId;
    if (roomId && socket.data.role === 'instructor') socket.to(roomId).emit('draw', strokeData);
  });

  socket.on('clear-board', () => {
    const roomId = socket.data.roomId;
    if (roomId && socket.data.role === 'instructor') socket.to(roomId).emit('clear-board');
  });

  // ---- Instructor controls ----
  socket.on('mute-participant', ({ targetId }) => {
    io.to(targetId).emit('force-mute');
  });

  socket.on('end-session', ({ roomId }) => {
    if (socket.data.role !== 'instructor') return;
    io.to(roomId).emit('session-ended');
    cleanupRoom(roomId);
  });

  // ---- Cleanup on disconnect ----
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (room) {
      // Close this participant's transports/producers/consumers
      const t = room.transports[socket.id];
      if (t) { if (t.send) t.send.close(); if (t.recv) t.recv.close(); }
      delete room.transports[socket.id];
      delete room.consumers[socket.id];

      Object.entries(room.producers).forEach(([producerId, p]) => {
        if (p.socketId === socket.id) {
          delete room.producers[producerId];
          socket.to(roomId).emit('producer-closed', { producerId });
        }
      });

      delete room.participants[socket.id];
      socket.to(roomId).emit('participant-left', { id: socket.id });

      if (Object.keys(room.participants).length === 0) cleanupRoom(roomId);
    }
    console.log(`[disconnect] ${socket.id}`);
  });
});

function findTransport(room, socketId, transportId) {
  const t = room?.transports[socketId];
  if (!t) return null;
  if (t.send && t.send.id === transportId) return t.send;
  if (t.recv && t.recv.id === transportId) return t.recv;
  return null;
}

function cleanupRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.router.close(); // closes all transports/producers/consumers for this room too
  delete rooms[roomId];
}

const PORT = process.env.PORT || 3000;
createWorker().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Classroom server (mediasoup SFU) running:`);
    console.log(`  - On this computer:  https://localhost:${PORT}`);
    console.log(`  - On other devices (same WiFi): https://<this-computer's-local-IP>:${PORT}`);
    if (!ANNOUNCED_IP) {
      console.log(`  ⚠ ANNOUNCED_IP is not set - audio/video will only work on localhost.`);
      console.log(`    For phones/other devices, set it: set ANNOUNCED_IP=192.168.x.x (Windows)`);
      console.log(`    or ANNOUNCED_IP=192.168.x.x npm start (Mac/Linux), using your local IP.`);
    }
  });
});