const db = require('../db/knex');

const Table = 'partie';

module.exports = {
   createGame: async (gameData) => {
      const [id] = await db(Table).insert({
         ligne_gagnante: gameData.move_sequence || null,
         move_sequence: gameData.move_sequence || null,
         joueur_depart: gameData.starting_player || null,
         signature: gameData.canonical_sequence || null,
         status: gameData.status || 'pending',
         joueur_gagnant: gameData.result || null,
         mode: gameData.mode || null,
         type_partie: gameData.type_partie || null,
         total_moves: gameData.total_moves || null,
         symmetric_game_id: gameData.symmetric_game_id || null,
         board_rows: gameData.board_rows || 6,
         board_cols: gameData.board_cols || 7,
         created_at: gameData.created_at || new Date()
      });
      return db(Table).where({ id_partie: id }).first();
   },

   findByMoveSequence: async (move_sequence) => {
      return await db(Table).where('move_sequence', move_sequence).first();
   },

   updateGame: async (id, updateData) => {
      await db(Table).where('id_partie', id).update(updateData);
      return db(Table).where('id_partie', id).first();
   },

   findAll: async () => {
      return db(Table)
         .select([
            'id_partie as id',
            
            'joueur_depart as starting_player',
            'signature',
            'status',
            'joueur_gagnant as result',
            'mode',
            'type_partie',
            'created_at'
         ])
         .orderBy('created_at', 'desc');
   },

   findOne: async (id) => {
      return db(Table).where('id_partie', id).first();
   },

   findByCanonical: async (canonicalSequence) => {
      return await db(Table).where('signature', canonicalSequence).first();
   },
   insertPartie : async (signature) =>{
      const [id_partie] = await db('partie')
         .insert({
            mode: 'standard',
            type_partie: 'ranked',
            status: 'finished',
            signature: signature
         })
      return db('partie').where({ id_partie }).first();
   },
   // 2️⃣ Insert situations into DB and set precedent/suivant
   insertSituations: async (id_partie, situations) => {
      const insertedIds = [];

      for (const s of situations) {
         const [id_situation] = await db('situation').insert({
            id_partie,
            numero_coup: s.numero_coup,
            plateau: s.plateau,
            joueur: s.joueur
         });
         
         insertedIds.push(id_situation);
      }

      // Update precedent / suivant
      for (let i = 0; i < insertedIds.length; i++) {
         await db('situation')
            .where({ id_situation: insertedIds[i] })
            .update({
               precedent: i > 0 ? insertedIds[i - 1] : null,
               suivant: i < insertedIds.length - 1 ? insertedIds[i + 1] : null
            });
      }

      return insertedIds;
   },


};
