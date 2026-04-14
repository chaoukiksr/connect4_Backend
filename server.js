require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { generateSituation } = require('./utils/trainingUtils.js');
const { registerSocketHandlers } = require('./socket/socketHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
}));
app.use(express.json());

// ── HTTP Routes ───────────────────────────────────────────────────────────────
const gameRoutes      = require('./routes/games');
const situationRoutes = require('./routes/situations');
const userRoutes      = require('./routes/user.js');
const bgaRoutes       = require('./routes/bga.js');
const suggestRoutes   = require('./routes/suggest.js');
const probabilityRoutes = require('./routes/probability.js');
const roomRoutes      = require('./routes/rooms');
const mlRoutes        = require('./routes/mlRoutes');

app.use('/api/games', gameRoutes);
app.use('/api', situationRoutes);
app.use('/user', userRoutes);
app.use('/api/bga', bgaRoutes);
app.use('/api/suggest-move', suggestRoutes);
app.use('/api/probability', probabilityRoutes);
app.use('/api/rooms', roomRoutes);   // Multiplayer rooms
app.use('/api/ml', mlRoutes);        // ML AI (AlphaZero)

app.get('/', (req, res) => {
  res.json({ message: 'Connect4 API is running', multiplayer: true });
});

// ── HTTP server + Socket.io ───────────────────────────────────────────────────
// We wrap Express in a plain http.Server so Socket.io can share the same port.
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
  // Enable WebSocket transport with polling fallback
  transports: ['websocket', 'polling'],
});

// Register all socket event handlers
registerSocketHandlers(io);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Multiplayer WebSocket enabled`);

  // Try to load ML model at startup (non-fatal if not present)
  try {
    const mlService = require('./services/mlService');
    await mlService.loadModel();
  } catch (err) {
    console.warn(`[Server] ML model not loaded: ${err.message}`);
    console.warn('[Server] Train a model with: python ml/alphazero.py --iterations 30');
  }
});
