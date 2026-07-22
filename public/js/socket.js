// public/js/socket.js
// Connects to the signaling server and exposes a few globals
// that webrtc.js and ui.js use.

const socket = io(); // connects back to the same server that served this page

let myName = '';
let myRole = '';
let myRoomId = '';

function joinRoom(name, role, roomId) {
  myName = name;
  myRole = role;
  myRoomId = roomId;
  socket.emit('join-room', { roomId, name, role });
}

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
