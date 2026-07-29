// public/js/socket.js
// Connects to the signaling server and exposes a few globals
// that webrtc.js and ui.js use.

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

let myName = '';
let myRole = '';
let myRoomId = '';
let hasJoinedOnce = false;

function joinRoom(name, role, roomId) {
  myName = name;
  myRole = role;
  myRoomId = roomId;
  hasJoinedOnce = true;
  socket.emit('join-room', { roomId, name, role });
}

// A brief WiFi drop disconnects the socket. Socket.IO reconnects
// automatically, but with a NEW connection (new socket.id) - the server no
// longer considers us part of the room, so chat/whiteboard/participant
// events would silently stop arriving. Rejoining on every (re)connect fixes
// that signaling side.
//
// But the server also throws away our old mediasoup transports/producers
// when the old socket disconnects (see server/index.js's disconnect
// handler) - so we ALSO need to rebuild the actual media connection here,
// not just the signaling one. Without this, video/audio silently breaks
// after any reconnect even though chat and the whiteboard keep working -
// setupMediasoup() is written to be safely callable again for exactly this.
socket.on('connect', () => {
  if (hasJoinedOnce) {
    socket.emit('join-room', { roomId: myRoomId, name: myName, role: myRole });

    if (window.setupMediasoup) {
      setupMediasoup(myRoomId, myRole).catch((err) => {
        console.error('Failed to rebuild the media connection after reconnect:', err);
      });
    }
  }
});

// Chat
function sendChatMessage(message) {
  socket.emit('chat-message', { roomId: myRoomId, message });
}

socket.on('chat-message', ({ name, message }) => {
  const log = document.getElementById('chat-log');
  const line = document.createElement('div');
  line.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(message)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

socket.on('force-mute', () => {
  if (window.forceMuteLocalMic) window.forceMuteLocalMic();
});

socket.on('session-ended', () => {
  alert('The instructor has ended this session.');
  window.location.reload();
});