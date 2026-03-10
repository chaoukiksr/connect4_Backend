/**
 * GameController (Multiplayer / Rooms)
 *
 * Handles the HTTP layer for room creation and retrieval.
 * Real-time gameplay is handled by the WebSocket layer (socketHandler.js).
 */

const roomService = require('../services/roomService');
const roomModel = require('../models/roomModel');

/**
 * POST /rooms
 * Create a new game room.
 *
 * Body (optional):
 *   { boardSize: { rows: 6, cols: 7 } }
 *
 * Response:
 *   { roomId, shareableUrl, boardSize }
 */
const createRoom = async (req, res) => {
  try {
    const boardSize = req.body.boardSize ?? { rows: 6, cols: 7 };

    // Clamp board size to sane values
    const safeSize = {
      rows: Math.min(Math.max(boardSize.rows ?? 6, 4), 12),
      cols: Math.min(Math.max(boardSize.cols ?? 7, 4), 12),
    };

    const room = await roomService.createRoom('pending', safeSize);

    res.status(201).json({
      roomId: room.roomId,
      shareableUrl: `/game/${room.roomId}`,
      boardSize: room.boardSize,
    });
  } catch (err) {
    console.error('[RoomController] createRoom error:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
};

/**
 * GET /rooms/:roomId
 * Get current room info (used by joining player to verify room exists).
 *
 * Response (active game):
 *   { roomId, gameStatus, playerCount, boardSize, currentPlayer }
 *
 * Response (finished game from DB):
 *   { roomId, gameStatus: 'finished', player1, player2, winner, moves }
 */
const getRoomInfo = async (req, res) => {
  try {
    const { roomId } = req.params;

    // Check in-memory first (active game)
    const room = roomService.getRoom(roomId);
    if (room) {
      return res.json({
        roomId: room.roomId,
        gameStatus: room.gameStatus,
        playerCount: room.player2 ? 2 : 1,
        boardSize: room.boardSize,
        currentPlayer: room.currentPlayer,
      });
    }

    // Fall back to DB (completed or abandoned game)
    const dbRoom = await roomModel.findByRoomId(roomId);
    if (!dbRoom) return res.status(404).json({ error: 'Room not found' });

    res.json({
      roomId: dbRoom.room_id,
      gameStatus: dbRoom.status,
      player1: dbRoom.player1_id,
      player2: dbRoom.player2_id,
      winner: dbRoom.winner,
      moves: dbRoom.moves ? JSON.parse(dbRoom.moves) : [],
      boardSize: parseBoardSize(dbRoom.board_size),
    });
  } catch (err) {
    console.error('[RoomController] getRoomInfo error:', err);
    res.status(500).json({ error: 'Failed to retrieve room info' });
  }
};

/**
 * POST /rooms/:roomId/join
 * Validate that a room can be joined (pre-WebSocket check).
 *
 * Response:
 *   { canJoin: true, boardSize }  or  { error }
 */
const joinRoom = (req, res) => {
  try {
    const { roomId } = req.params;
    const room = roomService.getRoom(roomId);

    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.gameStatus === 'finished') return res.status(410).json({ error: 'Game already finished' });
    if (room.player2 !== null) return res.status(409).json({ error: 'Room is full' });

    res.json({ canJoin: true, roomId, boardSize: room.boardSize });
  } catch (err) {
    console.error('[RoomController] joinRoom error:', err);
    res.status(500).json({ error: 'Failed to join room' });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse "6x7" → { rows: 6, cols: 7 } */
const parseBoardSize = (str) => {
  const [rows, cols] = (str ?? '6x7').split('x').map(Number);
  return { rows: rows || 6, cols: cols || 7 };
};

module.exports = { createRoom, getRoomInfo, joinRoom };
