// public/js/whiteboard.js
// Simple synced whiteboard: draw strokes locally, broadcast the
// coordinates through the signaling server (small data, not media,
// so it does NOT go through WebRTC - Socket.IO is fine for this).

const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');
ctx.strokeStyle = '#0b2a5b';
ctx.lineWidth = 3;
ctx.lineCap = 'round';

let drawing = false;
let last = { x: 0, y: 0 };

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height)
  };
}

function drawLine(from, to, emit) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  if (emit) {
    socket.emit('draw', { from, to });
  }
}

canvas.addEventListener('mousedown', (e) => {
  drawing = true;
  last = getPos(e);
});
canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const pos = getPos(e);
  drawLine(last, pos, true);
  last = pos;
});
window.addEventListener('mouseup', () => drawing = false);

// Touch support
canvas.addEventListener('touchstart', (e) => { drawing = true; last = getPos(e); });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!drawing) return;
  const pos = getPos(e);
  drawLine(last, pos, true);
  last = pos;
});
canvas.addEventListener('touchend', () => drawing = false);

// Receive strokes drawn by other participants
socket.on('draw', ({ from, to }) => {
  drawLine(from, to, false);
});

socket.on('clear-board', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

function clearWhiteboard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  socket.emit('clear-board');
}
