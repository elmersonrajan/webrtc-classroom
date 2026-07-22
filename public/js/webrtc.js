// public/js/webrtc.js
// This file implements the "mesh" WebRTC topology:
// every browser opens one RTCPeerConnection to every other browser.
// The Socket.IO connection (socket.js) is only used to exchange the
// small setup messages (offer / answer / ICE candidates).

// Free public STUN server - helps peers discover their own public IP.
// (A TURN server would be added here later for networks with strict NATs.)
const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

let localStream = null;
const peers = {}; // socketId -> RTCPeerConnection
const participants = {}; // socketId -> { name, role }

async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  document.getElementById('local-video').srcObject = localStream;
  return localStream;
}

function createPeerConnection(remoteId, remoteName) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[remoteId] = pc;

  // Send our local tracks (camera+mic) to this peer
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // When a new ICE candidate is found, forward it to the peer via the server
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: remoteId, data: { type: 'ice-candidate', candidate: event.candidate } });
    }
  };

  // When we receive the remote peer's media, show it in a <video> tag
  pc.ontrack = (event) => {
    let videoEl = document.getElementById('video-' + remoteId);
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.id = 'video-' + remoteId;
      videoEl.autoplay = true;
      videoEl.playsinline = true;
      document.getElementById('remote-videos').appendChild(videoEl);
    }
    videoEl.srcObject = event.streams[0];
  };

  return pc;
}

// Called when we already know about a peer and need to INITIATE the connection
async function callPeer(remoteId, remoteName) {
  const pc = createPeerConnection(remoteId, remoteName);
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
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });

  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

  } else if (data.type === 'ice-candidate') {
    if (pc) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { console.warn(e); }
    }
  }
});

// The server tells us who is already in the room when we join.
// We INITIATE a call to each of them.
socket.on('existing-participants', (list) => {
  list.forEach(p => {
    participants[p.id] = { name: p.name, role: p.role };
    addParticipantToList(p.id, p.name);
    callPeer(p.id, p.name);
  });
  updateParticipantCount();
});

// Someone new joined after us - we just wait for their offer (they call us)
socket.on('participant-joined', ({ id, name, role }) => {
  participants[id] = { name, role };
  addParticipantToList(id, name);
  updateParticipantCount();
});

socket.on('participant-left', ({ id }) => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  delete participants[id];
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
