/**
 * GameModel (Multiplayer)
 *
 * Data-access layer for the multiplayer_games table.
 * All database interactions for multiplayer rooms go through here.
 */

const db = require('../db/knex');

/**
 * Insert a new room row when a room is created via POST /rooms.
 * player2_id, moves, winner, etc. are filled in later.
 */
const createRoom = async (roomId, player1Id, boardSize = '6x7') => {
  await db('multiplayer_games').insert({
    room_id: roomId,
    player1_id: player1Id,
    board_size: boardSize,
    status: 'waiting',
  });
};

/**
 * Find a room record by its UUID.
 * Returns undefined if not found.
 */
const findByRoomId = async (roomId) => {
  return db('multiplayer_games').where({ room_id: roomId }).first();
};

/**
 * Persist the full game result when a game ends.
 * Stores both the move list and the final board snapshot.
 */
const saveCompletedGame = async (roomId, { player2Id, moves, winner, boardState }) => {
  await db('multiplayer_games').where({ room_id: roomId }).update({
    player2_id: player2Id,
    moves: JSON.stringify(moves),
    winner,
    board_state: JSON.stringify(boardState),
    status: 'finished',
    finished_at: db.fn.now(),
  });
};

/**
 * Mark a room as abandoned (e.g. a player disconnected and never returned).
 */
const markAbandoned = async (roomId) => {
  await db('multiplayer_games').where({ room_id: roomId }).update({
    status: 'abandoned',
    finished_at: db.fn.now(),
  });
};

/**
 * Update the status field (e.g. 'waiting' → 'playing').
 */
const updateStatus = async (roomId, status) => {
  await db('multiplayer_games').where({ room_id: roomId }).update({ status });
};

module.exports = { createRoom, findByRoomId, saveCompletedGame, markAbandoned, updateStatus };
