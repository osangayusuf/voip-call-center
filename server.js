const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Serve static assets from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Server State Management
const activeAgents = new Map(); // socket.id -> { id, name, status: 'available'|'busy'|'dnd', currentCall }
let customerQueue = [];         // Array of { id, name, department, issue, joinedAt }
const activeCalls = new Map();   // roomId -> { roomId, customerId, agentId, startedAt }

// Helper: Broadcast queue update to all agents
function broadcastQueueToAgents() {
  const queueData = customerQueue.map((item, index) => ({
    ...item,
    position: index + 1,
    waitTime: Math.round((Date.now() - item.joinedAt) / 1000) // in seconds
  }));

  const onlineAgentsCount = Array.from(activeAgents.values()).filter(a => a.status === 'available').length;

  activeAgents.forEach((agent, socketId) => {
    io.to(socketId).emit('queue-update', {
      queue: queueData,
      onlineAgentsCount
    });
  });
}

// Helper: Send personalized queue position to a single customer
function sendQueuePositionToCustomer(socketId) {
  const index = customerQueue.findIndex(c => c.id === socketId);
  if (index !== -1) {
    const position = index + 1;
    // Estimate wait time: 2 mins (120s) per person in front
    const estimatedWait = position * 120; 
    io.to(socketId).emit('queue-status', {
      position,
      estimatedWait,
      totalInQueue: customerQueue.length
    });
  }
}

// Helper: Broadcast queue position to all customers in queue
function updateAllCustomerPositions() {
  customerQueue.forEach(customer => {
    sendQueuePositionToCustomer(customer.id);
  });
}

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // ==========================================
  // AGENT EVENT HANDLERS
  // ==========================================

  // Agent Registers
  socket.on('agent-register', ({ name }) => {
    console.log(`[Agent Registered] Name: ${name}, ID: ${socket.id}`);
    activeAgents.set(socket.id, {
      id: socket.id,
      name: name || 'Agent',
      status: 'available',
      currentCall: null
    });
    
    // Send initial queue update to the newly registered agent
    broadcastQueueToAgents();
  });

  // Agent Status Updates (Available, DND/Offline)
  socket.on('agent-status-change', ({ status }) => {
    const agent = activeAgents.get(socket.id);
    if (agent) {
      console.log(`[Agent Status Change] ${agent.name} is now: ${status}`);
      agent.status = status;
      activeAgents.set(socket.id, agent);
      broadcastQueueToAgents();
    }
  });

  // Agent Accepts Next Customer
  socket.on('agent-accept-call', ({ customerId }) => {
    const agent = activeAgents.get(socket.id);
    if (!agent) {
      socket.emit('error-msg', { message: 'Agent not registered' });
      return;
    }

    if (agent.status !== 'available') {
      socket.emit('error-msg', { message: 'Agent status is not Available' });
      return;
    }

    // Find customer in queue (either specific customerId or take the first in queue)
    let customerIndex = -1;
    if (customerId) {
      customerIndex = customerQueue.findIndex(c => c.id === customerId);
    } else if (customerQueue.length > 0) {
      customerIndex = 0;
    }

    if (customerIndex === -1) {
      socket.emit('error-msg', { message: 'No customer available in the queue' });
      return;
    }

    // Extract customer and update queue
    const customer = customerQueue[customerIndex];
    customerQueue.splice(customerIndex, 1);
    
    const roomId = uuidv4();
    console.log(`[Call Matching] Agent: ${agent.name} <==> Customer: ${customer.name} | Room: ${roomId}`);

    // Update statuses
    agent.status = 'busy';
    agent.currentCall = roomId;
    activeAgents.set(socket.id, agent);

    // Save Call details
    activeCalls.set(roomId, {
      roomId,
      customerId: customer.id,
      agentId: socket.id,
      startedAt: Date.now()
    });

    // Make both join the socket room
    socket.join(roomId);
    
    const customerSocket = io.sockets.sockets.get(customer.id);
    if (customerSocket) {
      customerSocket.join(roomId);
    }

    // Trigger match events to coordinate WebRTC handshake
    // The agent will act as the Initiator (sends SDP Offer)
    io.to(customer.id).emit('call-matched', {
      roomId,
      peerName: agent.name,
      role: 'customer',
      isInitiator: false
    });

    io.to(socket.id).emit('call-matched', {
      roomId,
      peerName: customer.name,
      peerIssue: customer.issue,
      role: 'agent',
      isInitiator: true
    });

    // Update system states
    broadcastQueueToAgents();
    updateAllCustomerPositions();
  });

  // ==========================================
  // CUSTOMER EVENT HANDLERS
  // ==========================================

  // Customer Joins Queue
  socket.on('customer-join-queue', ({ name, department, issue }) => {
    console.log(`[Customer Joined Queue] Name: ${name}, Query: ${issue}, ID: ${socket.id}`);
    
    // Add to queue
    const customerInfo = {
      id: socket.id,
      name: name || 'Anonymous Customer',
      department: department || 'General Support',
      issue: issue || 'No issue description provided',
      joinedAt: Date.now()
    };
    
    customerQueue.push(customerInfo);

    // Update agents and customer
    broadcastQueueToAgents();
    sendQueuePositionToCustomer(socket.id);
  });

  // ==========================================
  // WEBRTC SIGNALING RELAY HANDLERS
  // ==========================================

  // Relay SDP Offers
  socket.on('webrtc-offer', ({ sdp, roomId }) => {
    console.log(`[Signaling] SDP Offer relayed in room: ${roomId}`);
    socket.to(roomId).emit('webrtc-offer', { sdp });
  });

  // Relay SDP Answers
  socket.on('webrtc-answer', ({ sdp, roomId }) => {
    console.log(`[Signaling] SDP Answer relayed in room: ${roomId}`);
    socket.to(roomId).emit('webrtc-answer', { sdp });
  });

  // Relay ICE Candidates
  socket.on('ice-candidate', ({ candidate, roomId }) => {
    // console.log(`[Signaling] ICE Candidate relayed in room: ${roomId}`);
    socket.to(roomId).emit('ice-candidate', { candidate });
  });

  // Handshake Call-End Signal
  socket.on('call-end', ({ roomId }) => {
    console.log(`[Call Manual End] Room: ${roomId}`);
    handleCallTearDown(roomId, socket.id);
  });

  // ==========================================
  // DISCONNECT & TEARDOWN LOGIC
  // ==========================================

  socket.on('disconnect', (reason) => {
    console.log(`[Socket Disconnected] ID: ${socket.id} | Reason: ${reason}`);

    // Case 1: Agent Disconnects
    if (activeAgents.has(socket.id)) {
      const agent = activeAgents.get(socket.id);
      console.log(`[Agent Offline] ${agent.name}`);
      
      if (agent.currentCall) {
        handleCallTearDown(agent.currentCall, socket.id);
      }
      
      activeAgents.delete(socket.id);
      broadcastQueueToAgents();
    }

    // Case 2: Customer Disconnects (while waiting in queue or during active call)
    const inQueueIndex = customerQueue.findIndex(c => c.id === socket.id);
    if (inQueueIndex !== -1) {
      console.log(`[Customer Left Queue] ${customerQueue[inQueueIndex].name}`);
      customerQueue.splice(inQueueIndex, 1);
      broadcastQueueToAgents();
      updateAllCustomerPositions();
    }

    // Check if customer was in an active call
    activeCalls.forEach((call, roomId) => {
      if (call.customerId === socket.id) {
        console.log(`[Customer Disconnected during Call] Room: ${roomId}`);
        handleCallTearDown(roomId, socket.id);
      }
    });
  });
});

// Tears down the active call session, resets statuses, and notifies surviving peer
function handleCallTearDown(roomId, disconnectedSocketId) {
  const call = activeCalls.get(roomId);
  if (!call) return;

  console.log(`[Tearing Down Call] Room: ${roomId}`);

  // Notify both peers that the call has ended
  io.to(roomId).emit('call-ended', { roomId });

  // Clean sockets from room
  const customerSocket = io.sockets.sockets.get(call.customerId);
  const agentSocket = io.sockets.sockets.get(call.agentId);

  if (customerSocket) customerSocket.leave(roomId);
  if (agentSocket) agentSocket.leave(roomId);

  // Reset Agent status
  const agent = activeAgents.get(call.agentId);
  if (agent) {
    agent.status = 'available';
    agent.currentCall = null;
    activeAgents.set(call.agentId, agent);
  }

  // Remove from active calls
  activeCalls.delete(roomId);

  // Trigger system update broadcasts
  broadcastQueueToAgents();
}

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`   VoIP CALLING CENTER SERVER INITIALIZED`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
