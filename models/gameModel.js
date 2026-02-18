const fs = require("fs");
const path = require("path");

const db = require('../db/knex');

const Table = 'partie';

module.exports = {
   findBySignature: async (signature) => {
      return await db(Table).where('signature', signature).first();
   },

   updateGame: async (id, updateData) => {
      await db(Table).where('id_partie', id).update(updateData);
      return db(Table).where('id_partie', id).first();
   },

   findAll: async () => {
      return db(Table)
         .select([
            'id_partie',
            'mode',
            'type_partie',
            'status',
            'joueur_depart',
            'joueur_gagnant',
            'ligne_gagnante',
            'signature',
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
   insertPartie : async ({
      joueur_depart,
      signature,
      status,
      joueur_gagnant,
      mode,
      type_partie,
      ligne_gagnante
   }) => {
      console.log('from insert in the model: ', mode,type_partie,joueur_depart,joueur_gagnant,ligne_gagnante,signature);
      
      const [id_partie] = await db('partie')
         .insert({
            mode: mode || 'standard',
            type_partie: type_partie || 'random',
            status: status || 'finished',
            joueur_depart: joueur_depart || null, joueur_gagnant: joueur_gagnant || null,ligne_gagnante: ligne_gagnante || null,
            signature: signature || null,
            created_at: new Date()
         });
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