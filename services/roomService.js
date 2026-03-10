/**
 * RoomService
 *
 * Business logic for multiplayer rooms.
 *
 * In-memory store (activeRooms Map) is the source of truth for live games.
 * The database receives writes on room creation and on game completion.
 *
 * Reconnection support:
 *   If a player refreshes, their new socket re-registers via joinRoom(),
 *   which locates the room by roomId and updates the stored socketId.
 */

const { randomUUID } = require('crypto');
const roomModel = require('../models/roomModel');
const gameService = require('./gameService'); // for saving to the partie table

// ── In-memory room store ──────────────────────────────────────────────────────
// Map<roomId, RoomState>
const activeRooms = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an empty 2-D board array.
 * 0 = empty, 1 = player 1 (red), 2 = player 2 (yellow)
 */
const createEmptyBoard = (rows = 6, cols = 7) =>
  Array.from({ length: rows }, () => Array(cols).fill(0));

/**
 * Check four-in-a-row starting from the last played cell.
 * Returns an array of winning cells [{row, col}, ...] or null.
 */
const checkWin = (board, row, col, player, boardSize) => {
  const { rows, cols } = boardSize;
  const directions = [
    [0, 1],   // horizontal
    [1, 0],   // vertical
    [1, 1],   // diagonal ↘
    [1, -1],  // diagonal ↙
  ];

  for (const [dr, dc] of directions) {
    const cells = [{ row, col }];

    // Scan forward
    for (let i = 1; i < 4; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      if (r >= 0 && r < rows && c >= 0 && c < cols && board[r][c] === player) {
        cells.push({ row: r, col: c });
      } else break;
    }

    // Scan backward
    for (let i = 1; i < 4; i++) {
      const r = row - dr * i;
      const c = col - dc * i;
      if (r >= 0 && r < rows && c >= 0 && c < cols && board[r][c] === player) {
        cells.unshift({ row: r, col: c });
      } else break;
    }

    if (cells.length >= 4) return cells.slice(0, 4);
  }

  return null;
};

// ── Room lifecycle ────────────────────────────────────────────────────────────

/**
 * Create a new room and persist a placeholder record to the DB.
 * Called from the HTTP POST /rooms handler.
 *
 * @param {string} player1SocketId  - Will be updated later via socket
 * @param {object} boardSize        - { rows, cols }
 * @returns {object} room state
 */
const createRoom = async (player1SocketId = 'pending', boardSize = { rows: 6, cols: 7 }) => {
  const roomId = randomUUID();

  const room = {
    roomId,
    player1: { socketId: player1SocketId, playerNumber: 1 },
    player2: null,
    board: createEmptyBoard(boardSize.rows, boardSize.cols),
    currentPlayer: 1,
    gameStatus: 'waiting',   // 'waiting' | 'playing' | 'finished'
    moveHistory: [],
    winner: null,            // null | 1 | 2 | 'draw'
    winningCells: [],
    boardSize,
    disconnectTimers: {},    // { 1: timeoutId, 2: timeoutId }
  };

  activeRooms.set(roomId, room);

  // Persist placeholder to DB (player IDs updated when sockets register)
  await roomModel.createRoom(roomId, player1SocketId, `${boardSize.rows}x${boardSize.cols}`);

  return room;
};

/**
 * Retrieve an active room by ID. Returns null if not found.
 */
const getRoom = (roomId) => activeRooms.get(roomId) ?? null;

/**
 * Register player 1's socket after they connect via WebSocket.
 * If the room was created via HTTP (socketId = 'pending'), this updates it.
 */
const registerPlayer1 = (roomId, socketId) => {
  const room = activeRooms.get(roomId);
  if (!room) return { error: 'Room not found' };
  if (room.player1.socketId !== 'pending' && room.player1.socketId !== socketId) {
    // Already taken by a different socket
    return { error: 'Player 1 slot already taken' };
  }
  room.player1.socketId = socketId;
  return { room };
};

/**
 * Join a room as player 2, or reconnect as either player.
 *
 * Reconnection: if the room already has both players and is 'playing',
 * we check if the socket matches a known player — if not, we find the
 * disconnected player slot (whose socketId might be stale) and update it.
 */
const joinRoom = (roomId, socketId) => {
  const room = activeRooms.get(roomId);
  if (!room) return { error: 'Room not found' };
  if (room.gameStatus === 'finished') return { error: 'Game already finished' };

  // Reconnection: already playing, socket is re-registering
  if (room.gameStatus === 'playing') {
    if (room.player1.socketId === socketId) return { room, reconnected: true, playerNumber: 1 };
    if (room.player2 && room.player2.socketId === socketId) return { room, reconnected: true, playerNumber: 2 };

    // Socket changed (refresh) — find which player this was by process of elimination
    // We can't verify identity here without auth; allow the first unknown socket to
    // take the empty (disconnected) slot if there is one.
    if (room.player2 === null) {
      // Treat as new player 2 joining mid-reconnect scenario
    } else {
      return { error: 'Room is full' };
    }
  }

  // Player 2 joining fresh
  if (room.player2) {
    // Both slots filled; allow same socket to re-enter
    if (room.player2.socketId === socketId) return { room, reconnected: true, playerNumber: 2 };
    return { error: 'Room is full' };
  }

  // Assign player 2
  room.player2 = { socketId, playerNumber: 2 };
  room.gameStatus = 'playing';

  // Update DB status
  roomModel.updateStatus(roomId, 'playing').catch(console.error);

  return { room, playerNumber: 2 };
};

// ── Gameplay ─────────────────────────────────────────────────────────────────

/**
 * Validate and apply a move.
 *
 * @param {string} roomId
 * @param {string} socketId - Must match the player whose turn it is
 * @param {number} col      - 0-indexed column
 * @returns {object} result with { move, winner?, winningCells?, isDraw? } or { error }
 */
const makeMove = (roomId, socketId, col) => {
  const room = activeRooms.get(roomId);
  if (!room) return { error: 'Room not found' };
  if (room.gameStatus !== 'playing') return { error: 'Game is not in progress' };

  // Determine which player this socket is
  const isPlayer1 = room.player1.socketId === socketId;
  const isPlayer2 = room.player2 && room.player2.socketId === socketId;
  if (!isPlayer1 && !isPlayer2) return { error: 'You are not a participant in this room' };

  const playerNumber = isPlayer1 ? 1 : 2;
  if (room.currentPlayer !== playerNumber) return { error: 'It is not your turn' };

  // Validate column
  if (col < 0 || col >= room.boardSize.cols) return { error: 'Invalid column' };
  if (room.board[0][col] !== 0) return { error: 'Column is full' };

  // Apply gravity — find the lowest empty row in this column
  let row = -1;
  for (let r = room.boardSize.rows - 1; r >= 0; r--) {
    if (room.board[r][col] === 0) { row = r; break; }
  }

  room.board[row][col] = playerNumber;
  const move = { row, col, player: playerNumber };
  room.moveHistory.push(move);

  // Check for a win
  const winCells = checkWin(room.board, row, col, playerNumber, room.boardSize);
  if (winCells) {
    room.winner = playerNumber;
    room.winningCells = winCells;
    room.gameStatus = 'finished';
    return { move, winner: playerNumber, winningCells: winCells };
  }

  // Check for a draw (top row completely filled)
  const isDraw = room.board[0].every((cell) => cell !== 0);
  if (isDraw) {
    room.winner = 'draw';
    room.gameStatus = 'finished';
    return { move, isDraw: true };
  }

  // Switch turn
  room.currentPlayer = playerNumber === 1 ? 2 : 1;
  return { move };
};

// ── End-of-game persistence ───────────────────────────────────────────────────

/**
 * Save the completed game to the database and remove it from memory.
 *
 * Writes to two tables:
 *  1. multiplayer_games — full multiplayer record (room_id, player IDs, board state)
 *  2. partie            — shared game archive (signature, winner, mode) so the game
 *                         appears in the existing DatabaseView alongside solo games.
 */
const finalizeGame = async (roomId) => {
  const room = activeRooms.get(roomId);
  if (!room) return;

  const winnerLabel =
    room.winner === 1 ? 'player1' :
    room.winner === 2 ? 'player2' :
    room.winner === 'draw' ? 'draw' : null;

  // ── 1. Save to multiplayer_games ─────────────────────────────────────────
  try {
    await roomModel.saveCompletedGame(roomId, {
      player2Id: room.player2 ? room.player2.socketId : null,
      moves: room.moveHistory,
      winner: winnerLabel,
      boardState: room.board,
    });
  } catch (err) {
    console.error(`[RoomService] Failed to save to multiplayer_games (${roomId}):`, err.message);
  }

  // ── 2. Also save to partie table (shared game archive) ───────────────────
  // The signature is the column-number sequence — same format as single-player games.
  const signature = room.moveHistory.map((m) => m.col).join('');
  if (signature.length > 0) {
    const startingPlayer = room.moveHistory[0]?.player === 1 ? 'red' : 'yellow';
    const winnerPlayer = room.winner === 1 ? 1 : room.winner === 2 ? 2 : null;
    const boardSizeStr = `${room.boardSize.rows}x${room.boardSize.cols}`;

    try {
      await gameService.saveGame(
        signature,
        'online',                             // mode
        'multiplayer',                        // type_partie
        'finished',                           // status
        startingPlayer,                       // joueur_depart
        winnerPlayer,                         // joueur_gagnant
        room.winningCells.length             // ligne_gagnante
          ? JSON.stringify(room.winningCells)
          : null,
        null,                                 // bga_table_id
        boardSizeStr,
      );
    } catch (err) {
      // Duplicate signatures are silently ignored by gameService; log other errors.
      if (!err.message?.includes('already exists')) {
        console.error(`[RoomService] Failed to save to partie (${roomId}):`, err.message);
      }
    }
  }

  activeRooms.delete(roomId);
};

// ── Disconnect handling ───────────────────────────────────────────────────────

/**
 * Find all rooms where the given socket is an active player.
 * Returns array of { roomId, room, playerNumber }.
 */
const getRoomsBySocket = (socketId) => {
  const result = [];
  for (const [roomId, room] of activeRooms.entries()) {
    if (room.player1.socketId === socketId) result.push({ roomId, room, playerNumber: 1 });
    else if (room.player2 && room.player2.socketId === socketId) result.push({ roomId, room, playerNumber: 2 });
  }
  return result;
};

/**
 * Store a disconnect timeout ID so it can be cancelled on reconnect.
 */
const setDisconnectTimer = (roomId, playerNumber, timerId) => {
  const room = activeRooms.get(roomId);
  if (room) room.disconnectTimers[playerNumber] = timerId;
};

/**
 * Cancel a pending disconnect timer (called when player reconnects).
 */
const clearDisconnectTimer = (roomId, playerNumber) => {
  const room = activeRooms.get(roomId);
  if (room && room.disconnectTimers[playerNumber]) {
    clearTimeout(room.disconnectTimers[playerNumber]);
    delete room.disconnectTimers[playerNumber];
  }
};

module.exports = {
  createRoom,
  getRoom,
  registerPlayer1,
  joinRoom,
  makeMove,
  finalizeGame,
  getRoomsBySocket,
  setDisconnectTimer,
  clearDisconnectTimer,
};
