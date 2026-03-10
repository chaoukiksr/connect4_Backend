/**
 * Migration: Create multiplayer_games table
 *
 * Stores completed and active multiplayer game records.
 * Active game state is managed in-memory by the socket handler;
 * this table receives a full write when a game ends (or is interrupted).
 */

exports.up = function (knex) {
  return knex.schema.createTable('multiplayer_games', (table) => {
    table.increments('id').primary();

    // Unique room identifier (UUID v4)
    table.string('room_id', 36).notNullable().unique();

    // Player identifiers — socket ID or username if authenticated
    table.string('player1_id', 100).nullable();
    table.string('player2_id', 100).nullable();

    // Full move list as a JSON array: [{row, col, player}, ...]
    table.text('moves').nullable();

    // Winner: 'player1', 'player2', 'draw', or null (game not finished)
    table.string('winner', 100).nullable();

    // Board dimensions stored as "ROWSxCOLS" e.g. "6x7"
    table.string('board_size', 20).notNullable().defaultTo('6x7');

    // Serialized board snapshot for reconnection support
    table.text('board_state').nullable();

    // Game lifecycle status
    table.enum('status', ['waiting', 'playing', 'finished', 'abandoned']).defaultTo('waiting');

    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('finished_at').nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('multiplayer_games');
};
