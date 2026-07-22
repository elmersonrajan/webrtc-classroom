// public/js/ui.js
// Wires the buttons from index.html to the functions in
// webrtc.js / whiteboard.js / socket.js

document.getElementById('join-btn').addEventListener('click', async () => {
  const name = document.getElementById('name-input').value.trim() || 'Guest';
  const role = document.getElementById('role-input').value;
  const roomId = document.getElementById('room-input').value.trim() || 'demo-room';

  try {
    await startLocalMedia();
  } catch (err) {
    alert('Could not access camera/mic: ' + err.message);
    return;
  }

  joinRoom(name, role, roomId);

  document.getElementById('join-screen').classList.add('hidden');
  document.getElementById('classroom').classList.remove('hidden');
});

// ---- Bottom control bar ----
const videoBtn = document.getElementById('video-toggle-btn');
videoBtn.addEventListener('click', () => {
  const isOn = toggleVideo();
  videoBtn.textContent = isOn ? 'Video Off' : 'Video On';
  videoBtn.classList.toggle('active', !isOn);
});

const micBtn = document.getElementById('mic-toggle-btn');
micBtn.addEventListener('click', () => {
  const isOn = toggleMic();
  micBtn.textContent = isOn ? 'Mute Mic' : 'Unmute Mic';
  micBtn.classList.toggle('active', !isOn);
});

document.getElementById('mute-others-btn').addEventListener('click', () => {
  Object.keys(peers).forEach(id => socket.emit('mute-participant', { targetId: id }));
});

let mediaRecorder = null;
let recordedChunks = [];
document.getElementById('record-btn').addEventListener('click', function () {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(localStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'session-recording.webm'; a.click();
    };
    mediaRecorder.start();
    this.textContent = 'Stop Record';
    this.classList.add('active');
  } else {
    mediaRecorder.stop();
    this.textContent = 'Record';
    this.classList.remove('active');
  }
});

document.getElementById('leave-btn').addEventListener('click', () => {
  window.location.reload();
});

// ---- Toolbar ----
document.getElementById('draw-btn').addEventListener('click', function () {
  this.classList.toggle('active');
});

document.getElementById('whiteboard-btn').addEventListener('click', () => {
  document.getElementById('whiteboard').classList.remove('hidden');
  document.getElementById('screen-video').classList.add('hidden');
  clearWhiteboard();
});

document.getElementById('screen-btn').addEventListener('click', async () => {
  try {
    document.getElementById('whiteboard').classList.add('hidden');
    const screenVideoEl = document.getElementById('screen-video');
    screenVideoEl.classList.remove('hidden');
    await startScreenShare();
  } catch (err) {
    console.warn('Screen share cancelled or failed', err);
    document.getElementById('screen-video').classList.add('hidden');
    document.getElementById('whiteboard').classList.remove('hidden');
  }
});

document.getElementById('clip-btn').addEventListener('click', () => {
  alert('Video Clip playback is a placeholder for this demo - wire it up to a video file or the screen-share track.');
});

// ---- Chat ----
document.getElementById('chat-send-btn').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  sendChatMessage(msg);
  input.value = '';
}
