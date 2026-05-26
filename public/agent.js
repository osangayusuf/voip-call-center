// Initialize Socket.io connection
const socket = io({
  transports: ['websocket']
});

// State Variables
let localStream = null;
let peerConnection = null;
let roomId = null;
let activeCustomer = null;
let ringingCustomer = null;
let isMuted = false;
let callDuration = 0;
let callTimerInterval = null;
let onlineStatus = 'available'; // 'available' | 'dnd'

// Statistics
let handledCallsCount = 0;
let totalHandlingTime = 0;

// DOM Elements
const setupSection = document.getElementById('agent-setup');
const dashboardSection = document.getElementById('agent-dashboard');

const setupForm = document.getElementById('setup-form');
const nameInput = document.getElementById('agent-name-input');

const nameLabel = document.getElementById('agent-name-label');
const statusLabel = document.getElementById('agent-status-label');
const statusToggleBtn = document.getElementById('status-toggle-btn');
const queueCountBadge = document.getElementById('queue-count-badge');
const queueListContainer = document.getElementById('queue-list');

const statActiveCalls = document.getElementById('stat-active-calls');
const statTotalCalls = document.getElementById('stat-total-calls');
const statAvgTime = document.getElementById('stat-avg-time');

const stateIdle = document.getElementById('state-idle');
const stateOffline = document.getElementById('state-offline');
const stateCall = document.getElementById('state-call');
const ringingOverlay = document.getElementById('ringing-overlay');

const ringingName = document.getElementById('ringing-caller-name');
const ringingIssue = document.getElementById('ringing-caller-issue');
const btnAcceptRinging = document.getElementById('btn-accept-ringing');
const btnRejectRinging = document.getElementById('btn-reject-ringing');
const ringtoneAudio = document.getElementById('ringtone-audio');

const activeCustomerName = document.getElementById('active-customer-name');
const activeCustomerDept = document.getElementById('active-customer-dept');
const callTimerDisplay = document.getElementById('agent-call-timer');
const remoteAudio = document.getElementById('agent-remote-audio');
const volumeCanvas = document.getElementById('agent-volume-canvas');
const btnMute = document.getElementById('btn-agent-mute');
const btnHangup = document.getElementById('btn-agent-hangup');

const callNotesInput = document.getElementById('call-notes-input');
const diagnosticLog = document.getElementById('diagnostic-log');
const historyTableBody = document.getElementById('history-table-body');

// ==========================================
// Setup & Registration
// ==========================================

setupForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const name = nameInput.value.trim();
  nameLabel.innerText = name;

  // Register with signaling server
  socket.emit('agent-register', { name });

  // Switch UI view
  setupSection.style.display = 'none';
  dashboardSection.style.display = 'flex';
  
  logDiagnostic(`Logged in as Agent: ${name}`);
});

// Helper: Logger for WebRTC Diagnostic Panel
function logDiagnostic(msg, isError = false) {
  const line = document.createElement('div');
  line.classList.add('diag-line');
  if (isError) line.classList.add('err');
  
  const timestamp = new Date().toLocaleTimeString();
  line.innerText = `[${timestamp}] ${msg}`;
  
  diagnosticLog.appendChild(line);
  diagnosticLog.scrollTop = diagnosticLog.scrollHeight;
}

// Socket.io Connection Diagnostics
socket.on('connect', () => {
  logDiagnostic(`Connected to signaling server with ID: ${socket.id}`);
});

socket.on('disconnect', (reason) => {
  logDiagnostic(`Disconnected from server. Reason: ${reason}`, true);
});

socket.on('connect_error', (error) => {
  logDiagnostic(`Socket connection error: ${error.message}`, true);
});

// ==========================================
// Status Toggle
// ==========================================

statusToggleBtn.addEventListener('click', () => {
  if (roomId) {
    alert('Cannot change availability status during an active customer call.');
    return;
  }

  if (onlineStatus === 'available') {
    onlineStatus = 'dnd';
    statusToggleBtn.innerText = 'Go Online';
    statusLabel.innerText = 'Offline';
    statusLabel.className = 'agent-status-badge dnd';
    
    // Switch workspace views
    stateIdle.classList.remove('active');
    stateOffline.classList.add('active');
    
    // Dismiss ringing overlay if open
    stopRinging();
  } else {
    onlineStatus = 'available';
    statusToggleBtn.innerText = 'Go Offline';
    statusLabel.innerText = 'Available';
    statusLabel.className = 'agent-status-badge';
    
    stateOffline.classList.remove('active');
    stateIdle.classList.add('active');
  }

  socket.emit('agent-status-change', { status: onlineStatus });
  logDiagnostic(`Availability status updated to: ${onlineStatus}`);
});

// ==========================================
// Queue management and Ringing Overlay
// ==========================================

socket.on('queue-update', ({ queue, onlineAgentsCount }) => {
  queueCountBadge.innerText = queue.length;
  
  // Re-render Customer queue lists
  if (queue.length === 0) {
    queueListContainer.innerHTML = `
      <div class="empty-queue-msg">
        <span class="empty-queue-icon">🍃</span>
        <span>No customers in queue</span>
      </div>
    `;
    stopRinging();
    return;
  }

  queueListContainer.innerHTML = '';
  queue.forEach(customer => {
    const card = document.createElement('div');
    card.className = 'customer-queue-card';
    card.innerHTML = `
      <div class="c-card-header">
        <span class="c-name">${customer.name}</span>
        <span class="c-wait-pill">${customer.waitTime}s ago</span>
      </div>
      <div class="c-issue">"${customer.issue}"</div>
      <div class="c-meta">
        <span class="c-dept">${customer.department}</span>
        <button class="btn btn-primary btn-accept-c" data-id="${customer.id}">Accept 🎧</button>
      </div>
    `;
    
    // Add Click listener to Accept call from list
    card.querySelector('.btn-accept-c').addEventListener('click', (e) => {
      const customerId = e.target.getAttribute('data-id');
      acceptCustomer(customerId);
    });

    queueListContainer.appendChild(card);
  });

  // Ring overlay logic:
  // If agent is available, not in an active call, and there is a customer waiting:
  if (onlineStatus === 'available' && !roomId && queue.length > 0 && !ringingCustomer) {
    startRinging(queue[0]);
  }
});

function startRinging(customer) {
  ringingCustomer = customer;
  ringingName.innerText = customer.name;
  ringingIssue.innerText = `"${customer.issue}"`;
  
  ringingOverlay.classList.add('active');

  // Play incoming ringtone loop safely
  try {
    ringtoneAudio.currentTime = 0;
    ringtoneAudio.play();
  } catch (err) {
    console.log('Interaction required to play audio tone:', err);
  }
  
  logDiagnostic(`Ringing: Incoming call from ${customer.name}`);
}

function stopRinging() {
  ringingCustomer = null;
  ringingOverlay.classList.remove('active');
  ringtoneAudio.pause();
  ringtoneAudio.currentTime = 0;
}

btnRejectRinging.addEventListener('click', () => {
  stopRinging();
  logDiagnostic('Incoming call dismissed by Agent');
});

// Accept Customer Call (triggers socket matchmaking on server)
btnAcceptRinging.addEventListener('click', () => {
  if (ringingCustomer) {
    acceptCustomer(ringingCustomer.id);
  }
});

function acceptCustomer(customerId) {
  stopRinging();
  logDiagnostic(`Accepting Call for customer socket: ${customerId}`);
  socket.emit('agent-accept-call', { customerId });
}

// ==========================================
// WebRTC Call Match & Handshake
// ==========================================

socket.on('call-matched', async ({ roomId: id, peerName, peerIssue, role, isInitiator }) => {
  console.log(`[Matched Call] Joined Room: ${id} with Customer: ${peerName}`);
  logDiagnostic(`Establishing secure WebRTC tunnel...`);

  roomId = id;
  activeCustomer = { id, name: peerName, issue: peerIssue };

  // Set workspace views
  stateIdle.classList.remove('active');
  stateOffline.classList.remove('active');
  stateCall.classList.add('active');

  // Update UI headers
  activeCustomerName.innerText = peerName;
  activeCustomerDept.innerText = peerIssue || 'Customer Query';
  callNotesInput.value = '';
  statActiveCalls.innerText = '1';

  try {
    // 1. Capture local audio input
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    logDiagnostic('[Media] Microphone captured successfully');
  } catch (err) {
    logDiagnostic('[Media Error] Microphone access denied! Establishing muted connection...', true);
    alert('Microphone access is required to speak with customers. The connection will succeed but they will not hear you.');
  }

  // 2. Instantiate Peer Connection
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  peerConnection = new RTCPeerConnection(rtcConfig);

  // 3. Bind stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // 4. Remote track listening
  peerConnection.ontrack = (event) => {
    logDiagnostic('[WebRTC] Receiving customer audio track');
    remoteAudio.srcObject = event.streams[0];
    
    // Canvas audio analyzer
    setupAudioVisualizer(event.streams[0]);
  };

  // 5. ICE Candidate gathered
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { candidate: event.candidate, roomId });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    logDiagnostic(`[WebRTC Diagnostic] Connection state changed: ${peerConnection.connectionState}`);
    if (peerConnection.connectionState === 'connected') {
      logDiagnostic(`Secure WebRTC tunnel established successfully. Free P2P Call active.`, false);
    } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
      handleLocalHangup();
    }
  };

  // 6. If the agent is the Initiator, negotiate the SDP offer
  if (isInitiator) {
    try {
      logDiagnostic('Creating SDP Negotiation Offer...');
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      
      logDiagnostic('Sending Offer SDP to Customer');
      socket.emit('webrtc-offer', { sdp: offer, roomId });
    } catch (err) {
      logDiagnostic(`[Signaling Error] Failed to generate SDP Offer: ${err.message}`, true);
    }
  }

  // Start Call Timer
  startCallTimer();
});

// Received SDP Answer from Customer
socket.on('webrtc-answer', async ({ sdp }) => {
  if (!peerConnection) return;
  logDiagnostic('Received Answer SDP from Customer. Setting Remote Description.');
  
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    logDiagnostic('Remote Description set successfully. Connection negotiation ready.');
  } catch (err) {
    logDiagnostic(`[Signaling Error] Failed to set Remote SDP: ${err.message}`, true);
  }
});

// Received ICE Candidate
socket.on('ice-candidate', async ({ candidate }) => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Failed to add remote ICE Candidate:', err);
  }
});

// Call manual shutdown via signaling
socket.on('call-ended', () => {
  logDiagnostic('Call has been terminated by Customer / Signaling.');
  handleLocalHangup(false);
});

// ==========================================
// Canvas Volume Visualizer using Web Audio API
// ==========================================
let audioCtx = null;
let visualizerAnimation = null;

function setupAudioVisualizer(remoteStream) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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

        // Custom Gradient: Neon Violet to success emerald
        const gradient = canvasCtx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#6366f1');
        gradient.addColorStop(0.7, '#818cf8');
        gradient.addColorStop(1, '#10b981');

        canvasCtx.fillStyle = gradient;
        canvasCtx.fillRect(x, height - barHeight, barWidth - 2, barHeight);

        x += barWidth;
      }
    }
    draw();
  } catch (err) {
    console.error('Audio visualizer setup failed:', err);
  }
}

// ==========================================
// Timers and Controls Operations
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

btnHangup.addEventListener('click', () => {
  if (roomId) {
    logDiagnostic('Ending active call session...');
    socket.emit('call-end', { roomId });
  }
  handleLocalHangup(true);
});

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
    logDiagnostic('Microphone muted locally');
  } else {
    btnMute.innerText = '🎤 Mute Mic';
    btnMute.classList.add('btn-outline');
    btnMute.classList.remove('btn-danger');
    logDiagnostic('Microphone unmuted locally');
  }
});

// Tears down connection and re-calculates statistics
function handleLocalHangup(saveHistory = true) {
  // Stop Timers
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  // Cancel visualizer loop
  if (visualizerAnimation) {
    cancelAnimationFrame(visualizerAnimation);
    visualizerAnimation = null;
  }

  // Close media devices
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Close RTC peer connections
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Log session to local history
  if (saveHistory && activeCustomer) {
    logCallToHistory({
      callerName: activeCustomer.name,
      dept: activeCustomer.issue || 'Support Request',
      duration: callDuration,
      notes: callNotesInput.value.trim() || 'No session notes provided.'
    });
  }

  logDiagnostic('Call closed successfully. Resetting lines...');

  // Reset states
  roomId = null;
  activeCustomer = null;
  ringingCustomer = null;
  isMuted = false;
  btnMute.innerText = '🎤 Mute Mic';
  btnMute.classList.add('btn-outline');
  btnMute.classList.remove('btn-danger');
  
  statActiveCalls.innerText = '0';

  // Toggle View
  stateCall.classList.remove('active');
  
  if (onlineStatus === 'available') {
    stateIdle.classList.add('active');
  } else {
    stateOffline.classList.add('active');
  }
}

// Log a call record and recalculate metrics
function logCallToHistory(record) {
  handledCallsCount++;
  totalHandlingTime += record.duration;

  // Calculate Avg Handling Time
  const avgSecs = Math.round(totalHandlingTime / handledCallsCount);
  
  // Update dashboard stats widgets
  statTotalCalls.innerText = handledCallsCount;
  statAvgTime.innerText = `${avgSecs}s`;

  // Insert row in table
  const minutes = String(Math.floor(record.duration / 60)).padStart(2, '0');
  const seconds = String(record.duration % 60).padStart(2, '0');
  const durationText = `${minutes}:${seconds}`;

  const row = document.createElement('tr');
  row.innerHTML = `
    <td><strong>${record.callerName}</strong></td>
    <td>${record.dept}</td>
    <td><code style="font-family:'JetBrains Mono';">${durationText}</code></td>
    <td>Customer Query</td>
    <td class="notes-cell" title="${record.notes}">${record.notes}</td>
  `;

  // Remove placeholder row if this is the first entry
  if (handledCallsCount === 1) {
    historyTableBody.innerHTML = '';
  }

  historyTableBody.insertBefore(row, historyTableBody.firstChild);
}
