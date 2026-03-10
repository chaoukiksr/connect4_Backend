/**
 * Socket Handler
 *
 * Registers all Socket.io event handlers for multiplayer gameplay.
 * Called once during server startup with the io instance.
 *
 * ─── WebSocket Events ────────────────────────────────────────────────────────
 *
 * Client → Server:
 *   createRoom  { roomId }           Register as player 1 in an existing room
 *   joinRoom    { roomId }           Join as player 2, or reconnect
 *   makeMove    { roomId, col }      Play a piece in the given column
 *
 * Server → Client:
 *   roomCreated        { roomId, boardSize, playerNumber }
 *   playerJoined       { playerCount }
 *   gameStarted        { board, currentPlayer, boardSize, yourPlayer }
 *   moveMade           { board, move, currentPlayer }
 *   gameEnded          { winner, winningCells, moves }
 *   playerDisconnected { playerNumber, gracePeriodMs }
 *   playerReconnected  { playerNumber }
 *   roomState          { board, currentPlayer, boardSize, yourPlayer, moveHistory }
 *   roomError          { message }
 */

const roomService = require('../services/roomService');
const roomModel = require('../models/roomModel');

// How long (ms) to wait before forfeiting a disconnected player's game
const DISCONNECT_GRACE_MS = 30_000;

/**
 * Register all socket event handlers.
 * @param {import('socket.io').Server} io
 */
const registerSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // ── createRoom ──────────────────────────────────────────────────────────
    /**
     * Called by Player 1 after creating a room via POST /rooms.
     * Links their socket to the room and joins the socket.io room channel.
     *
     * Payload: { roomId }
     */
    socket.on('createRoom', ({ roomId } = {}) => {
      if (!roomId) return socket.emit('roomError', { message: 'roomId is required' });

      const result = roomService.registerPlayer1(roomId, socket.id);
      if (result.error) return socket.emit('roomError', { message: result.error });

      const { room } = result;

      // Join the socket.io room channel for broadcasting
      socket.join(roomId);

      socket.emit('roomCreated', {
        roomId,
        boardSize: room.boardSize,
        playerNumber: 1,
      });

      console.log(`[Socket] Room ${roomId} registered by player 1 (${socket.id})`);
    });

    // ── joinRoom ────────────────────────────────────────────────────────────
    /**
     * Called by Player 2 to join a room, or by any player to reconnect.
     *
     * Payload: { roomId }
     */
    socket.on('joinRoom', ({ roomId } = {}) => {
      if (!roomId) return socket.emit('roomError', { message: 'roomId is required' });

      const result = roomService.joinRoom(roomId, socket.id);
      if (result.error) return socket.emit('roomError', { message: result.error });

      const { room, reconnected, playerNumber } = result;

      // Join socket.io channel
      socket.join(roomId);

      if (reconnected) {
        // Cancel any pending disconnect forfeit timer
        roomService.clearDisconnectTimer(roomId, playerNumber);

        // Notify the reconnected player of the current game state
        socket.emit('roomState', {
          board: room.board,
          currentPlayer: room.currentPlayer,
          boardSize: room.boardSize,
          yourPlayer: playerNumber,
          moveHistory: room.moveHistory,
          gameStatus: room.gameStatus,
        });

        // Notify the other player
        socket.to(roomId).emit('playerReconnected', { playerNumber });
        console.log(`[Socket] Player ${playerNumber} reconnected to room ${roomId}`);
        return;
      }

      // Fresh join as player 2
      // Notify the joining player of their assigned number and room state
      socket.emit('roomJoined', {
        roomId,
        boardSize: room.boardSize,
        playerNumber,
      });

      // Notify all players in the room that the game is starting
      io.to(roomId).emit('gameStarted', {
        board: room.board,
        currentPlayer: room.currentPlayer,
        boardSize: room.boardSize,
        yourPlayer: playerNumber, // each client receives their own number
      });

      // Player 1's client needs to know their number too — send targeted event
      // (gameStarted above went to everyone; player 1 receives yourPlayer=2 which is wrong)
      // Fix: send individually
      const sockets = io.sockets.adapter.rooms.get(roomId);
      if (sockets) {
        for (const sid of sockets) {
          const targetSocket = io.sockets.sockets.get(sid);
          if (!targetSocket) continue;

          const isP1 = room.player1.socketId === sid;
          targetSocket.emit('gameStarted', {
            board: room.board,
            currentPlayer: room.currentPlayer,
            boardSize: room.boardSize,
            yourPlayer: isP1 ? 1 : 2,
          });
        }
      }

      // Notify player 1 that someone joined
      socket.to(roomId).emit('playerJoined', { playerCount: 2 });

      console.log(`[Socket] Player 2 (${socket.id}) joined room ${roomId} — game started`);
    });

    // ── makeMove ────────────────────────────────────────────────────────────
    /**
     * A player drops a piece into a column.
     *
     * Payload: { roomId, col }
     */
    socket.on('makeMove', async ({ roomId, col } = {}) => {
      if (!roomId || col === undefined) {
        return socket.emit('roomError', { message: 'roomId and col are required' });
      }

      const result = roomService.makeMove(roomId, socket.id, col);
      if (result.error) return socket.emit('roomError', { message: result.error });

      const room = roomService.getRoom(roomId);

      // Broadcast the updated board state to all players in the room
      io.to(roomId).emit('moveMade', {
        board: room.board,
        move: result.move,
        currentPlayer: room.currentPlayer,
      });

      // ── Game over ──────────────────────────────────────────────────────
      if (result.winner !== undefined || result.isDraw) {
        const winnerLabel = result.isDraw ? 'draw' : `player${result.winner}`;

        io.to(roomId).emit('gameEnded', {
          winner: result.isDraw ? null : result.winner,       // 1 | 2 | null
          winnerLabel,                                         // 'player1' | 'player2' | 'draw'
          winningCells: result.winningCells ?? [],
          moves: room.moveHistory,
        });

        console.log(`[Socket] Room ${roomId} ended — winner: ${winnerLabel}`);

        // Persist to DB then remove from memory
        await roomService.finalizeGame(roomId);
      }
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    /**
     * When a socket disconnects, give the player a grace period to reconnect
     * before forfeiting the game.
     */
    socket.on('disconnect', async () => {
      console.log(`[Socket] Disconnected: ${socket.id}`);

      const affected = roomService.getRoomsBySocket(socket.id);

      for (const { roomId, room, playerNumber } of affected) {
        if (room.gameStatus !== 'playing') continue;

        // Notify the other player
        io.to(roomId).emit('playerDisconnected', {
          playerNumber,
          gracePeriodMs: DISCONNECT_GRACE_MS,
        });

        // Start forfeit timer
        const timer = setTimeout(async () => {
          const liveRoom = roomService.getRoom(roomId);
          if (!liveRoom || liveRoom.gameStatus !== 'playing') return;

          // Forfeit: the other player wins
          const opponentNumber = playerNumber === 1 ? 2 : 1;
          liveRoom.winner = opponentNumber;
          liveRoom.gameStatus = 'finished';

          io.to(roomId).emit('gameEnded', {
            winner: opponentNumber,
            winnerLabel: `player${opponentNumber}`,
            winningCells: [],
            moves: liveRoom.moveHistory,
            forfeit: true,
          });

          console.log(`[Socket] Room ${roomId} forfeited — player ${playerNumber} didn't reconnect`);
          await roomService.finalizeGame(roomId);
        }, DISCONNECT_GRACE_MS);

        roomService.setDisconnectTimer(roomId, playerNumber, timer);
      }
    });
  });
};

module.exports = { registerSocketHandlers };
