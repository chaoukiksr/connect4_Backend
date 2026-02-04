
const db= require('../db/knex');

const Table = 'games';

module.exports = {
   createGame: async (gameData) =>{
      console.log('canonical sequence from model: ', gameData.canonical_sequence);
      
      const [id] = await db(Table).insert({
         move_sequence: gameData.move_sequence,
         starting_player: gameData.starting_player,
         canonical_sequence:gameData.canonical_sequence,
         symmetric_game_id:gameData.symmetric_game_id,
         total_moves: gameData.total_moves,
         status: gameData.status,
         result: gameData.result,
         board_rows: gameData.board_rows,
         board_cols: gameData.board_cols,
         imported_from: gameData.imported_from,
         created_at: gameData.created_at
      })
      return db(Table).where({'id':id}).first();
   },
   findByMoveSequesnce : async (move_sequence) =>{
      return await db(Table).where('move_sequence',move_sequence).first();
   },
   updateGame: async (id, updateData) =>{
      await db(Table).where('id', id).update(updateData);
      return db(Table).where('id', id).first();
   },
   findAll: async () =>{
      return db(Table)
      .select('*')
      .orderBy('created_at', 'desc');
   },
   findOne: async () =>{

   },
   findByCanonical: async (canonicalSequence) =>{
      return await db(Table).where('canonical_sequence', canonicalSequence).first();
   }
}