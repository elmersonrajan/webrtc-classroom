// public/js/webrtc.js
// SFU version: instead of connecting directly to every other browser (mesh),
// this browser opens exactly TWO connections to the server - one to SEND
// its own media ("send transport") and one to RECEIVE everyone else's
// ("recv transport"). The server (mediasoup) handles forwarding media to
// whoever needs it. This scales far better than mesh once you have more
// than a handful of participants.

let localStream = null;
let device = null;            // mediasoup-client Device - knows what codecs this browser supports
let sendTransport = null;     // our one outgoing connection to the server
let recvTransport = null;     // our one incoming connection from the server
let micProducer = null;
let cameraProducer = null;
let screenProducer = null;

const participants = {};      // socketId -> { name, role }
const mainStreams = {};       // socketId -> MediaStream combining that person's mic+camera
const consumersByProducerId = {}; // producerId -> { consumer, socketId, mediaType }

let readyToConsume = false;
let queuedProducers = [];     // producers that arrived before we were ready to consume them

// Wraps Socket.IO's callback-style requests in a Promise so we can use await
function emitWithAck(event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

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

  if (role === 'instructor') {
    const el = document.getElementById('instructor-video-el');
    el.srcObject = localStream;
    el.muted = true; // this is YOUR OWN mic playing back - mute locally so you don't hear yourself.
  }

  return localStream;
}

// Called once, right after joining a room - sets up the mediasoup Device
// and both transports, then starts sending our own camera/mic.
async function setupMediasoup(roomId, role) {
  await window.mediasoupClientReadyPromise; // wait for the CDN import (see index.html) to finish
  if (!window.mediasoupClient || !window.mediasoupClient.Device) {
    throw new Error(
      'The mediasoup-client library failed to load from the CDN. ' +
      'Check your internet connection and the browser console (F12) for the underlying error.'
    );
  }

  const { rtpCapabilities } = await emitWithAck('get-router-rtp-capabilities', { roomId });

  device = new window.mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });

  await createSendTransport(roomId);
  await createRecvTransport(roomId);
  await produceLocalTracks();

  readyToConsume = true;
  queuedProducers.forEach(p => consumeProducer(roomId, p));
  queuedProducers = [];
}

async function createSendTransport(roomId) {
  const params = await emitWithAck('create-transport', { roomId, direction: 'send' });
  sendTransport = device.createSendTransport(params);

  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    emitWithAck('connect-transport', { roomId, transportId: sendTransport.id, dtlsParameters })
      .then(callback).catch(errback);
  });

  sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
    emitWithAck('produce', { roomId, transportId: sendTransport.id, kind, rtpParameters, appData })
      .then(({ id }) => callback({ id })).catch(errback);
  });
}

async function createRecvTransport(roomId) {
  const params = await emitWithAck('create-transport', { roomId, direction: 'recv' });
  recvTransport = device.createRecvTransport(params);

  recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    emitWithAck('connect-transport', { roomId, transportId: recvTransport.id, dtlsParameters })
      .then(callback).catch(errback);
  });
}

async function produceLocalTracks() {
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    micProducer = await sendTransport.produce({ track: audioTrack, appData: { mediaType: 'mic' } });
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    cameraProducer = await sendTransport.produce({ track: videoTrack, appData: { mediaType: 'camera' } });
  }
}

function getOrCreateMainStream(socketId) {
  if (!mainStreams[socketId]) mainStreams[socketId] = new MediaStream();
  return mainStreams[socketId];
}

// ------------------------------------------------------------------
// Autoplay handling
// ------------------------------------------------------------------
// Browsers block .play() on <video>/<audio> elements with sound unless it
// happens very close to a real user click. By the time a remote track
// arrives here, we've gone through several `await`s (device load, transport
// setup, consume round-trip) since the user clicked "Join session", so the
// browser's permission window has usually expired. That's why remote video
// looked like a black screen and there was no sound, even though the data
// was arriving fine.
//
// Fix: always call .play() ourselves and check whether it was blocked. If
// it was, show a one-time "Click to enable audio/video" banner - clicking
// it is a fresh user gesture, which satisfies the browser and unlocks
// playback for every remote element on the page.
let playbackBlocked = false;

function tryPlay(videoEl) {
  const playPromise = videoEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      if (err.name === 'NotAllowedError') {
        showUnlockPlaybackBanner();
      } else {
        console.warn('video.play() failed:', err);
      }
    });
  }
}

function showUnlockPlaybackBanner() {
  if (playbackBlocked) return; // already showing
  playbackBlocked = true;

  const banner = document.createElement('div');
  banner.id = 'unlock-playback-banner';
  banner.textContent = 'Click here to enable audio & video';
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    background: #d94b4b; color: #fff; text-align: center;
    padding: 14px; font-weight: 600; font-size: 15px; cursor: pointer;
  `;
  banner.addEventListener('click', () => {
    // Re-attempt play() on every remote video element now that we have a
    // fresh, real user click to satisfy the browser's autoplay policy.
    document.querySelectorAll('video').forEach((el) => { if (el.srcObject) tryPlay(el); });
    banner.remove();
    playbackBlocked = false;
  });
  document.body.appendChild(banner);
}

// Start receiving a specific remote producer (someone's mic, camera, or screen)
async function consumeProducer(roomId, { producerId, socketId, kind, appData }) {
  if (!readyToConsume) { queuedProducers.push({ producerId, socketId, kind, appData }); return; }
  if (socketId === socket.id) return; // never consume our own media

  const result = await emitWithAck('consume', { roomId, producerId, rtpCapabilities: device.rtpCapabilities });
  if (result.error) { console.warn('Could not consume', producerId, result.error); return; }

  const consumer = await recvTransport.consume({
    id: result.id,
    producerId: result.producerId,
    kind: result.kind,
    rtpParameters: result.rtpParameters,
  });
  consumersByProducerId[producerId] = { consumer, socketId, mediaType: appData?.mediaType };

  await emitWithAck('resume-consumer', { roomId, consumerId: consumer.id });

  routeIncomingTrack(socketId, appData?.mediaType, consumer.track);
}

// Decides which UI element a newly-arrived track belongs in, based on the
// sender's role and what kind of media it is (mic/camera/screen)
function routeIncomingTrack(socketId, mediaType, track) {
  const remoteRole = participants[socketId]?.role;

  if (mediaType === 'screen') {
    // Only the instructor shares their screen in this app - it always goes
    // on the main stage. Visibility (whiteboard vs screen) is controlled by
    // the screen-share-started/stopped broadcast, not here.
    const screenEl = document.getElementById('screen-video');
    screenEl.srcObject = new MediaStream([track]);
    tryPlay(screenEl);
    return;
  }

  // mic or camera - combine into one MediaStream per person, so audio+video
  // play together from whichever element represents them
  const stream = getOrCreateMainStream(socketId);
  stream.addTrack(track);

  if (remoteRole === 'instructor') {
    const el = document.getElementById('instructor-video-el');
    el.srcObject = stream;
    tryPlay(el);
    return;
  }

  // Another student - small tile in the grid. Audio-only peers still need a
  // playing element for their mic - just hidden visually.
  let videoEl = document.getElementById('video-' + socketId);
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.id = 'video-' + socketId;
    videoEl.autoplay = true;
    videoEl.playsinline = true;
    document.getElementById('remote-videos').appendChild(videoEl);
  }
  videoEl.srcObject = stream;
  videoEl.classList.toggle('audio-only', stream.getVideoTracks().length === 0);
  tryPlay(videoEl);
}

// ---- Socket event wiring ----

socket.on('existing-participants', (list) => {
  list.forEach(p => {
    participants[p.id] = { name: p.name, role: p.role };
    if (!document.getElementById('participant-' + p.id)) addParticipantToList(p.id, p.name);
  });
  updateParticipantCount();
});

socket.on('participant-joined', ({ id, name, role }) => {
  participants[id] = { name, role };
  if (!document.getElementById('participant-' + id)) addParticipantToList(id, name);
  updateParticipantCount();
});

socket.on('existing-producers', (list) => {
  list.forEach(p => consumeProducer(myRoomId, p));
});

socket.on('new-producer', ({ producerId, socketId, name, role, kind, appData }) => {
  if (name && role) participants[socketId] = { name, role }; // in case it arrives before participant-joined
  consumeProducer(myRoomId, { producerId, socketId, kind, appData });
});

socket.on('producer-closed', ({ producerId }) => {
  const entry = consumersByProducerId[producerId];
  if (!entry) return;
  const { consumer, socketId, mediaType } = entry;

  if (mediaType === 'screen') {
    document.getElementById('screen-video').srcObject = null;
  } else {
    const stream = mainStreams[socketId];
    if (stream) stream.removeTrack(consumer.track);
  }

  consumer.close();
  delete consumersByProducerId[producerId];
});

socket.on('participant-left', ({ id }) => {
  delete participants[id];
  delete mainStreams[id];
  const videoEl = document.getElementById('video-' + id);
  if (videoEl) videoEl.remove();
  const rowEl = document.getElementById('participant-' + id);
  if (rowEl) rowEl.remove();
  updateParticipantCount();
});

socket.on('screen-share-started', () => {
  document.getElementById('screen-video').classList.remove('hidden');
  document.getElementById('whiteboard').classList.add('hidden');
});

socket.on('screen-share-stopped', () => {
  const screenVideoEl = document.getElementById('screen-video');
  screenVideoEl.classList.add('hidden');
  screenVideoEl.srcObject = null;
  document.getElementById('whiteboard').classList.remove('hidden');
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
  if (!track) return false;
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

// ---- Screen share: a separate producer, only ever created by the instructor ----
async function startScreenShare() {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const screenTrack = screenStream.getVideoTracks()[0];

  screenProducer = await sendTransport.produce({ track: screenTrack, appData: { mediaType: 'screen' } });

  const screenVideo = document.getElementById('screen-video');
  screenVideo.srcObject = screenStream;
  socket.emit('screen-share-started', { roomId: myRoomId });

  screenTrack.onended = () => stopScreenShare();

  return screenStream;
}

async function stopScreenShare() {
  if (screenProducer) {
    socket.emit('close-producer', { roomId: myRoomId, producerId: screenProducer.id });
    screenProducer.close();
    screenProducer = null;
  }

  document.getElementById('screen-video').classList.add('hidden');
  document.getElementById('screen-video').srcObject = null;
  socket.emit('screen-share-stopped', { roomId: myRoomId });
}