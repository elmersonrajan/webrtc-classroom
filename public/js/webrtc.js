// public/js/webrtc.js
// This file implements the "mesh" WebRTC topology:
// every browser opens one RTCPeerConnection to every other browser.
// The Socket.IO connection (socket.js) is only used to exchange the
// small setup messages (offer / answer / ICE candidates).

// Multiple STUN servers - if one is briefly slow/unreachable, others still work.
// (A TURN server would be added here later for networks with strict NATs.)
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

let localStream = null;
const peers = {}; // socketId -> RTCPeerConnection
const participants = {}; // socketId -> { name, role }

async function startLocalMedia(role) {
  // Students don't need a camera - they only watch the board and the
  // instructor's video, and can speak up via mic. Instructors send both.
  const wantsVideo = role === 'instructor';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: wantsVideo, audio: true });
  } catch (err) {
    // Camera/mic combo failed (e.g. no camera on this device) - fall back to audio only
    localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
  }

  // Only the instructor's own preview goes in the "Instructor Video" panel.
  // Students will have this panel filled in later, once the instructor's
  // remote video track arrives (see ontrack below).
  if (role === 'instructor') {
    const el = document.getElementById('instructor-video-el');
    el.srcObject = localStream;
    el.muted = true; // this is YOUR OWN mic playing back - mute locally so you don't hear yourself.
                      // Other participants still hear you fine, since their copy of this
                      // element (filled via the remote instructor track below) is not muted.
  }

  return localStream;
}

function createPeerConnection(remoteId, remoteName) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[remoteId] = pc;
  pendingCandidates[remoteId] = [];

  // Send our local tracks (camera+mic) to this peer
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // When a new ICE candidate is found, forward it to the peer via the server
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: remoteId, data: { type: 'ice-candidate', candidate: event.candidate } });
    }
  };

  // If the connection drops or fails (common on flaky WiFi), try to
  // self-heal instead of leaving that participant frozen/silent forever.
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === 'failed') {
      attemptIceRestart(remoteId, pc);
    } else if (state === 'disconnected') {
      // 'disconnected' can recover on its own within a couple seconds -
      // only step in if it's still stuck after a short grace period
      setTimeout(() => {
        if (peers[remoteId] === pc && pc.iceConnectionState === 'disconnected') {
          attemptIceRestart(remoteId, pc);
        }
      }, 3000);
    }
  };

  // When we receive the remote peer's media, show it in a <video> tag
  pc.ontrack = (event) => {
    const remoteRole = participants[remoteId]?.role;
    const stream = event.streams[0];
    const hasVideo = stream.getVideoTracks().length > 0;

    // The instructor's stream always goes into the dedicated "Instructor
    // Video" panel, for every participant (including other instructors' view)
    if (remoteRole === 'instructor') {
      document.getElementById('instructor-video-el').srcObject = stream;
      return;
    }

    // Everyone else (other students) gets a tile in the small grid.
    // Camera-less peers still need a playing element for their mic audio -
    // we just hide it visually rather than skip creating it.
    let videoEl = document.getElementById('video-' + remoteId);
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.id = 'video-' + remoteId;
      videoEl.autoplay = true;
      videoEl.playsinline = true;
      document.getElementById('remote-videos').appendChild(videoEl);
    }
    videoEl.srcObject = stream;
    videoEl.classList.toggle('audio-only', !hasVideo);
  };

  return pc;
}

// Only the side that originally sent the offer restarts ICE, to avoid both
// sides trying to renegotiate at once (which causes its own instability).
const isInitiator = {}; // remoteId -> bool

async function attemptIceRestart(remoteId, pc) {
  if (peers[remoteId] !== pc) return; // already replaced/closed
  if (!isInitiator[remoteId]) return; // let the other side drive the restart
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: remoteId, data: { type: 'offer', sdp: offer } });
  } catch (e) {
    console.warn('ICE restart failed for', remoteId, e);
  }
}

// Candidates that arrive before we've set the remote description yet get
// queued here instead of being silently dropped (a common cause of
// "sometimes no video/audio" on real networks where messages can arrive
// slightly out of order).
const pendingCandidates = {}; // remoteId -> [candidate, ...]

async function flushPendingCandidates(remoteId, pc) {
  const queued = pendingCandidates[remoteId] || [];
  pendingCandidates[remoteId] = [];
  for (const candidate of queued) {
    try { await pc.addIceCandidate(candidate); } catch (e) { console.warn(e); }
  }
}

// Called when we already know about a peer and need to INITIATE the connection
async function callPeer(remoteId, remoteName) {
  const pc = createPeerConnection(remoteId, remoteName);
  isInitiator[remoteId] = true;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: remoteId, data: { type: 'offer', sdp: offer } });
}

// Incoming signaling messages (offer / answer / ICE) from other peers
socket.on('signal', async ({ from, data }) => {
  let pc = peers[from];

  if (data.type === 'offer') {
    if (!pc) pc = createPeerConnection(from, participants[from]?.name);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushPendingCandidates(from, pc); // any candidates that arrived early can now be applied
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });

  } else if (data.type === 'answer') {
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushPendingCandidates(from, pc);
    }

  } else if (data.type === 'ice-candidate') {
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      // Remote description already set - safe to apply immediately
      try { await pc.addIceCandidate(data.candidate); } catch (e) { console.warn(e); }
    } else {
      // Remote description not set yet - queue it instead of dropping it
      if (!pendingCandidates[from]) pendingCandidates[from] = [];
      pendingCandidates[from].push(data.candidate);
    }
  }
});

// The server tells us who is already in the room when we join (or rejoin
// after a brief disconnect). We INITIATE a call to each of them - but skip
// anyone we already have a live connection to, so a reconnect doesn't
// create duplicate connections.
socket.on('existing-participants', (list) => {
  list.forEach(p => {
    participants[p.id] = { name: p.name, role: p.role };
    if (!document.getElementById('participant-' + p.id)) addParticipantToList(p.id, p.name);

    const existingPc = peers[p.id];
    const alreadyConnected = existingPc &&
      (existingPc.connectionState === 'connected' || existingPc.connectionState === 'connecting');
    if (!alreadyConnected) {
      callPeer(p.id, p.name);
    }
  });
  updateParticipantCount();
});

// Someone new joined after us - we just wait for their offer (they call us)
socket.on('participant-joined', ({ id, name, role }) => {
  participants[id] = { name, role };
  if (!document.getElementById('participant-' + id)) addParticipantToList(id, name);
  updateParticipantCount();
});

socket.on('participant-left', ({ id }) => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  delete participants[id];
  delete pendingCandidates[id];
  delete isInitiator[id];
  const videoEl = document.getElementById('video-' + id);
  if (videoEl) videoEl.remove();
  const rowEl = document.getElementById('participant-' + id);
  if (rowEl) rowEl.remove();
  updateParticipantCount();
});

function addParticipantToList(id, name) {
  const list = document.getElementById('participants-list');
  const row = document.createElement('div');
  row.id = 'participant-' + id;
  row.textContent = name;
  list.appendChild(row);
}

function updateParticipantCount() {
  const count = Object.keys(participants).length + 1; // +1 for yourself
  document.getElementById('participants-header').textContent = `Participants (${count})`;
}

// ---- Mic / camera toggles ----
function toggleMic() {
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  return track.enabled;
}

function toggleVideo() {
  const track = localStream.getVideoTracks()[0];
  if (!track) return false; // no camera on this device/role
  track.enabled = !track.enabled;
  return track.enabled;
}

window.forceMuteLocalMic = function () {
  const track = localStream.getAudioTracks()[0];
  if (track) track.enabled = false;
  document.getElementById('mic-toggle-btn').classList.add('active');
  document.getElementById('mic-toggle-btn').textContent = 'Unmute Mic';
};

// ---- Screen share: replace the outgoing video track on every peer connection ----
async function startScreenShare() {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const screenTrack = screenStream.getVideoTracks()[0];

  Object.values(peers).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(screenTrack);
  });

  const screenVideo = document.getElementById('screen-video');
  screenVideo.srcObject = screenStream;

  // When the user stops sharing (browser's built-in "Stop sharing" button),
  // switch back to the camera track automatically
  screenTrack.onended = () => stopScreenShare();

  return screenStream;
}

function stopScreenShare() {
  const camTrack = localStream.getVideoTracks()[0];
  Object.values(peers).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && camTrack) sender.replaceTrack(camTrack);
  });
  document.getElementById('screen-video').classList.add('hidden');
  document.getElementById('screen-video').srcObject = null;
}