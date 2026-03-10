/**
 * Rooms Router
 *
 * Mounts the HTTP endpoints for multiplayer room management.
 * Real-time events are handled separately by the Socket.io layer.
 *
 * Routes:
 *   POST   /rooms                  → create a room
 *   GET    /rooms/:roomId          → get room info
 *   POST   /rooms/:roomId/join     → validate room before WebSocket join
 */

const express = require('express');
const router = express.Router();
const { createRoom, getRoomInfo, joinRoom } = require('../controllers/roomController');

router.post('/', createRoom);
router.get('/:roomId', getRoomInfo);
router.post('/:roomId/join', joinRoom);

module.exports = router;
