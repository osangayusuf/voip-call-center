// Initialize Socket.io connection
const socket = io({
  transports: ['websocket']
});

socket.on('connect', () => {
  console.log(`[Socket Connected] ID: ${socket.id}`);
});

socket.on('disconnect', (reason) => {
  console.log(`[Socket Disconnected] Reason: ${reason}`);
});

socket.on('connect_error', (err) => {
  console.error('[Socket Connection Error]', err);
});

// State Variables
let localStream = null;
let peerConnection = null;
let roomId = null;
let callTimerInterval = null;
let callDuration = 0;
let isMuted = false;

// DOM Elements
const intakeSection = document.getElementById('customer-intake');
const lobbySection = document.getElementById('customer-lobby');
const callSection = document.getElementById('customer-call');
const endedSection = document.getElementById('customer-ended');

const intakeForm = document.getElementById('intake-form');
const nameInput = document.getElementById('customer-name');
const deptSelect = document.getElementById('customer-dept');
const issueTextarea = document.getElementById('customer-issue');

const posDisplay = document.getElementById('queue-position-display');
const waitDisplay = document.getElementById('queue-wait-display');
const totalDisplay = document.getElementById('queue-total-display');

const agentNameDisplay = document.getElementById('call-agent-name');
const callTimerDisplay = document.getElementById('call-timer');
const remoteAudio = document.getElementById('remote-audio');
const volumeCanvas = document.getElementById('volume-canvas');
const btnMute = document.getElementById('btn-mute');
const btnHangup = document.getElementById('btn-hangup');

const musicToggleBtn = document.getElementById('music-toggle-btn');
const holdStatusDesc = document.getElementById('hold-status-desc');
const holdMusicWaves = document.getElementById('hold-music-waves');

// ==========================================
// Web Audio API Synthesizer (Hold Music)
// ==========================================
let audioCtx = null;
let synthNodes = [];
let synthInterval = null;
let isSynthPlaying = false;
let currentChordIndex = 0;

// Beautiful Ambient Chord Progressions (Frequencies in Hz)
const CHORDS = [
  [174.61, 220.00, 261.63, 329.63], // Fmaj7 (F3, A3, C4, E4)
  [196.00, 246.94, 293.66, 392.00], // G6 (G3, B3, D4, G4)
  [130.81, 196.00, 246.94, 329.63], // Cmaj7 (C3, G3, B3, E4)
  [110.00, 220.00, 261.63, 329.63, 392.00] // Am9 (A2, A3, C4, E4, G4)
];

function initSynth() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function startHoldMusic() {
  initSynth();
  if (isSynthPlaying) return;

  isSynthPlaying = true;
  musicToggleBtn.innerText = '⏸️';
  holdStatusDesc.innerText = 'Ambient synthesizer playing...';
  holdMusicWaves.style.display = 'flex';

  // Resume context if suspended (browser security)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Play immediately, then loop
  playNextChord();
  synthInterval = setInterval(playNextChord, 4000);
}

function stopHoldMusic() {
  if (!isSynthPlaying) return;

  isSynthPlaying = false;
  musicToggleBtn.innerText = '▶️';
  holdStatusDesc.innerText = 'Hold music muted';
  holdMusicWaves.style.display = 'none';

  if (synthInterval) {
    clearInterval(synthInterval);
    synthInterval = null;
  }

  // Fade out and stop any active oscillator nodes
  synthNodes.forEach(node => {
    try {
      node.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      node.gainNode.gain.setValueAtTime(node.gainNode.gain.value, audioCtx.currentTime);
      node.gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);
      setTimeout(() => {
        node.osc.stop();
      }, 600);
    } catch (e) {
      console.log('Osc already stopped:', e);
    }
  });
  synthNodes = [];
}

function playNextChord() {
  if (!isSynthPlaying || !audioCtx) return;

  const now = audioCtx.currentTime;
  const chord = CHORDS[currentChordIndex];
  
  // Set up a master warm lowpass filter to remove harsh frequencies
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(450, now);
  filter.Q.setValueAtTime(1.5, now);
  filter.connect(audioCtx.destination);

  // Play each note in the chord
  chord.forEach((freq, index) => {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    // Use Triangle wave (warm, retro flutey sound)
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);

    // Fade notes in slightly staggered times (arpeggio effect)
    const noteStart = now + (index * 0.08);
    
    // Gain envelope (soft attack, long decay)
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.04, noteStart + 1.2); // soft entry
    gainNode.gain.setValueAtTime(0.04, noteStart + 2.5); // hold
    gainNode.gain.exponentialRampToValueAtTime(0.0001, noteStart + 3.8); // fade out

    osc.connect(gainNode);
    gainNode.connect(filter);

    osc.start(now);
    // Automatically stop to free memory
    osc.stop(now + 4.0);

    synthNodes.push({ osc, gainNode });
  });

  // Cycle chords
  currentChordIndex = (currentChordIndex + 1) % CHORDS.length;

  // Clean old node references
  setTimeout(() => {
    synthNodes = synthNodes.filter(node => node.osc.context.currentTime < now + 4.0);
  }, 4500);
}

// Toggle button click listener
musicToggleBtn.addEventListener('click', () => {
  if (isSynthPlaying) {
    stopHoldMusic();
  } else {
    startHoldMusic();
  }
});

// ==========================================
// Queue Joining and Flow Control
// ==========================================

intakeForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const name = nameInput.value.trim();
  const department = deptSelect.value;
  const issue = issueTextarea.value.trim();

  // Send request to server
  socket.emit('customer-join-queue', { name, department, issue });

  // Transition UI views
  intakeSection.classList.remove('active');
  lobbySection.classList.add('active');

  // Trigger Hold Music (browser interaction block is bypassed because we are in a submit handler!)
  startHoldMusic();
});

// ==========================================
// Socket Queue Event Listeners
// ==========================================

socket.on('queue-status', ({ position, estimatedWait, totalInQueue }) => {
  posDisplay.innerText = `#${position}`;
  
  if (estimatedWait < 60) {
    waitDisplay.innerText = `${estimatedWait}s`;
  } else {
    waitDisplay.innerText = `~${Math.round(estimatedWait / 60)} min`;
  }
  
  totalDisplay.innerText = totalInQueue;
});

// Matched with agent - configure WebRTC peer
socket.on('call-matched', async ({ roomId: id, peerName }) => {
  console.log(`[Matched Call] Joined Room: ${id} with Agent: ${peerName}`);
  
  roomId = id;
  agentNameDisplay.innerText = peerName;

  // Stop wait hold music
  stopHoldMusic();

  // Transition views
  lobbySection.classList.remove('active');
  callSection.classList.add('active');

  try {
    // 1. Capture local audio
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log('[Media] Microphone captured successfully.');
  } catch (err) {
    console.error('[Media Error] Microphone access denied or unavailable:', err);
    alert('Warning: Microphone access is required to speak with the agent. The call will connect but you will be muted.');
  }

  // 2. Establish RTC Peer Connection
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  
  peerConnection = new RTCPeerConnection(rtcConfig);

  // 3. Bind Local Media Tracks to Connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // 4. Set up Remote Track Handler
  peerConnection.ontrack = (event) => {
    console.log('[WebRTC] Remote track received.');
    remoteAudio.srcObject = event.streams[0];
    
    // Play audio context
    initSynth();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    // Setup high-fidelity canvas audio analyzer on incoming agent stream
    setupAudioAnalyzer(event.streams[0]);
  };

  // 5. Setup ICE candidate gatherers
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { candidate: event.candidate, roomId });
    }
  };

  // State changes logging
  peerConnection.onconnectionstatechange = () => {
    console.log(`[WebRTC StateChange] connectionState: ${peerConnection.connectionState}`);
    if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
      handleLocalHangup();
    }
  };

  // Start active call timer count
  startCallTimer();
});

// ==========================================
// WebRTC Signaling Listeners
// ==========================================

// Received SDP offer from Agent
socket.on('webrtc-offer', async ({ sdp }) => {
  if (!peerConnection) return;
  console.log('[Signaling] Received Offer SDP from Agent. Processing...');

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    console.log('[Signaling] Created Answer SDP. Sending to Agent.');
    socket.emit('webrtc-answer', { sdp: answer, roomId });
  } catch (err) {
    console.error('[Signaling Error] Failed to handle WebRTC SDP Offer:', err);
  }
});

// Received ICE candidates
socket.on('ice-candidate', async ({ candidate }) => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('[WebRTC Error] Failed to add remote ICE Candidate:', err);
  }
});

// Server forces call end
socket.on('call-ended', () => {
  console.log('[Signaling] Server notification: call has ended.');
  handleLocalHangup(false);
});

// ==========================================
// Canvas Volume Visualizer using Web Audio API
// ==========================================
let visualizerAnimation = null;

function setupAudioAnalyzer(remoteStream) {
  try {
    initSynth();
    const source = audioCtx.createMediaStreamSource(remoteStream);
    const analyser = audioCtx.createAnalyser();
    
    analyser.fftSize = 64;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const canvasCtx = volumeCanvas.getContext('2d');
    const width = volumeCanvas.width;
    const height = volumeCanvas.height;

    function draw() {
      visualizerAnimation = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      canvasCtx.fillStyle = 'rgba(10, 15, 30, 0.4)';
      canvasCtx.fillRect(0, 0, width, height);

      const barWidth = (width / bufferLength) * 1.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;

        // Indigo to emerald gradient depending on volume height
        const gradient = canvasCtx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#6366f1');
        gradient.addColorStop(0.7, '#a5b4fc');
        gradient.addColorStop(1, '#10b981');

        canvasCtx.fillStyle = gradient;
        canvasCtx.fillRect(x, height - barHeight, barWidth - 2, barHeight);

        x += barWidth;
      }
    }
    
    // Start drawing loop
    draw();
  } catch (err) {
    console.error('[Audio Visualizer Error] Web Audio visualizer setup failed:', err);
  }
}

// ==========================================
// Control Operations & Teardown
// ==========================================

function startCallTimer() {
  callDuration = 0;
  callTimerDisplay.innerText = '00:00';
  
  if (callTimerInterval) clearInterval(callTimerInterval);
  
  callTimerInterval = setInterval(() => {
    callDuration++;
    const mins = String(Math.floor(callDuration / 60)).padStart(2, '0');
    const secs = String(callDuration % 60).padStart(2, '0');
    callTimerDisplay.innerText = `${mins}:${secs}`;
  }, 1000);
}

// Hangup button clicked
btnHangup.addEventListener('click', () => {
  if (roomId) {
    socket.emit('call-end', { roomId });
  }
  handleLocalHangup(true);
});

// Mute button clicked
btnMute.addEventListener('click', () => {
  if (!localStream) return;

  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });

  if (isMuted) {
    btnMute.innerText = '🔊 Unmute Mic';
    btnMute.classList.remove('btn-outline');
    btnMute.classList.add('btn-danger');
  } else {
    btnMute.innerText = '🎤 Mute Mic';
    btnMute.classList.add('btn-outline');
    btnMute.classList.remove('btn-danger');
  }
});

// Shuts down connection locally
function handleLocalHangup(shouldTransition = true) {
  // Clear timers
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  // Cancel visualizer animations
  if (visualizerAnimation) {
    cancelAnimationFrame(visualizerAnimation);
    visualizerAnimation = null;
  }

  // Stop hold music completely
  stopHoldMusic();

  // Close media stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Close peer connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  isMuted = false;
  btnMute.innerText = '🎤 Mute Mic';
  btnMute.classList.add('btn-outline');
  btnMute.classList.remove('btn-danger');

  // Transition UI
  if (shouldTransition) {
    callSection.classList.remove('active');
    endedSection.classList.add('active');
  }
}
