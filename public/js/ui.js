// public/js/ui.js
// Wires the buttons from index.html to the functions in
// webrtc.js / whiteboard.js / socket.js

document.getElementById('join-btn').addEventListener('click', async () => {
  const name = document.getElementById('name-input').value.trim() || 'Guest';
  const role = document.getElementById('role-input').value;
  const roomId = document.getElementById('room-input').value.trim() || 'demo-room';

  try {
    await startLocalMedia(role);
  } catch (err) {
    alert('Could not access microphone: ' + err.message);
    return;
  }

  document.body.classList.add('role-' + role); // lets CSS hide instructor-only controls for students

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

// Composite recording: draws the whiteboard (or screen share, whichever is
// currently visible) as the main frame, with the instructor's own camera as
// a small picture-in-picture overlay in the corner - so the recording shows
// BOTH the board and the teacher, not just the camera.
let mediaRecorder = null;
let recordedChunks = [];
let recordCanvas = null;
let recordCtx = null;
let recordAnimationId = null;

function startCompositeRecording() {
  recordCanvas = document.createElement('canvas');
  recordCanvas.width = 1280;
  recordCanvas.height = 720;
  recordCtx = recordCanvas.getContext('2d');

  const whiteboardEl = document.getElementById('whiteboard');
  const screenVideoEl = document.getElementById('screen-video');
  const cameraEl = document.getElementById('instructor-video-el');

  function drawFrame() {
    recordCtx.fillStyle = '#ffffff';
    recordCtx.fillRect(0, 0, recordCanvas.width, recordCanvas.height);

    // Main frame: screen share if it's active, otherwise the whiteboard
    const usingScreenShare = !screenVideoEl.classList.contains('hidden') && screenVideoEl.videoWidth > 0;
    if (usingScreenShare) {
      recordCtx.drawImage(screenVideoEl, 0, 0, recordCanvas.width, recordCanvas.height);
    } else {
      recordCtx.drawImage(whiteboardEl, 0, 0, recordCanvas.width, recordCanvas.height);
    }

    // Picture-in-picture: instructor's camera, bottom-right corner
    if (cameraEl.videoWidth > 0) {
      const w = 220, h = 165, margin = 20;
      const x = recordCanvas.width - w - margin;
      const y = recordCanvas.height - h - margin;
      recordCtx.drawImage(cameraEl, x, y, w, h);
      recordCtx.strokeStyle = '#0b2a5b';
      recordCtx.lineWidth = 3;
      recordCtx.strokeRect(x, y, w, h);
    }

    recordAnimationId = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  // Combine the composited canvas (video) with the instructor's mic (audio)
  const canvasStream = recordCanvas.captureStream(30);
  const audioTracks = localStream.getAudioTracks();
  const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(combinedStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    cancelAnimationFrame(recordAnimationId);
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'session-recording.webm'; a.click();
  };
  mediaRecorder.start();
}

document.getElementById('record-btn').addEventListener('click', function () {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    startCompositeRecording();
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
