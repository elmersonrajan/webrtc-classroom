const { io } = require('socket.io-client');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed cert, test only

const socket = io('https://localhost:3000', { rejectUnauthorized: false });

function emitWithAck(event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

socket.on('connect', async () => {
  try {
    console.log('connected:', socket.id);

    socket.emit('join-room', { roomId: 'test-room', name: 'Test Instructor', role: 'instructor' });
    await new Promise(r => setTimeout(r, 300));

    const { rtpCapabilities } = await emitWithAck('get-router-rtp-capabilities', { roomId: 'test-room' });
    console.log('got rtpCapabilities:', !!rtpCapabilities, 'codecs:', rtpCapabilities.codecs.length);

    const sendParams = await emitWithAck('create-transport', { roomId: 'test-room', direction: 'send' });
    console.log('send transport created:', !!sendParams.id, sendParams.id);

    const recvParams = await emitWithAck('create-transport', { roomId: 'test-room', direction: 'recv' });
    console.log('recv transport created:', !!recvParams.id, recvParams.id);

    console.log('ALL CHECKS PASSED');
    process.exit(0);
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exit(1);
  }
});

socket.on('connect_error', (e) => { console.error('connect_error:', e.message); process.exit(1); });

setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 8000);
