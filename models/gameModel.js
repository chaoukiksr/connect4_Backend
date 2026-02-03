
const db= require('../db/knex');

const Table = 'games';

module.exports = {
   createGame: async (gameData) =>{
      const [id] = await db(Table).insert({
         move_sequence: gameData.move_sequence,
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
   updateGame: async () =>{

   },
   findAll: async () =>{

   },
   findOne: async () =>{

   },
   findCanonical: async () =>{

   }
}