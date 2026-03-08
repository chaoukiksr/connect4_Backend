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
            'bga_table_id',
            'board_size',
            'created_at'
         ])
         .orderBy('created_at', 'desc');
   },

   findAllPaginated: async (page = 1, limit = 20) => {
      const offset = (page - 1) * limit;
      const [rows, countResult] = await Promise.all([
         db(Table)
            .select(['id_partie','mode','type_partie','status','joueur_depart',
                     'joueur_gagnant','signature','bga_table_id','board_size','created_at'])
            .orderBy('created_at', 'desc')
            .limit(limit).offset(offset),
         db(Table).count('id_partie as total').first()
      ]);
      return { rows, total: Number(countResult.total), page, limit };
   },

   findOne: async (id) => {
      return db(Table).where('id_partie', id).first();
   },

   findByCanonical: async (canonicalSequence) => {
      return await db(Table).where('signature', canonicalSequence).first();
   },

   findByBgaId: async (bgaTableId) => {
      return await db(Table).where('bga_table_id', String(bgaTableId)).first();
   },

   deleteById: async (id) => {
      return db(Table).where('id_partie', id).delete();
   },

   getStats: async () => {
      const [total, byWinner, avgLength] = await Promise.all([
         db(Table).count('id_partie as total').first(),
         db(Table).select('joueur_gagnant').count('* as count').groupBy('joueur_gagnant'),
         db(Table).avg(db.raw('LENGTH(signature)') ).as('avg').first()
      ]);
      const winMap = {};
      for (const row of byWinner) winMap[row.joueur_gagnant || 'null'] = Number(row.count);
      // Column frequency — compute from all signatures
      const sigs = await db(Table).pluck('signature');
      const colFreq = Array(9).fill(0);
      for (const sig of sigs) {
         if (!sig) continue;
         for (const ch of sig) {
            const c = parseInt(ch, 10);
            if (!isNaN(c) && c < colFreq.length) colFreq[c]++;
         }
      }
      const totalMoves = colFreq.reduce((a, b) => a + b, 0);
      const colFreqPct = colFreq.map(n => totalMoves ? Math.round((n / totalMoves) * 1000) / 10 : 0);
      const totalGames = Number(total.total);
      return {
         totalGames,
         redWins:    winMap['R'] || 0,
         yellowWins: winMap['Y'] || 0,
         draws:      winMap['null'] || 0,
         avgMoves:   sigs.filter(Boolean).length
            ? Math.round(sigs.filter(Boolean).reduce((s, sig) => s + sig.length, 0) / sigs.filter(Boolean).length)
            : 0,
         colFrequency: colFreqPct,
      };
   },
   insertPartie : async ({
      joueur_depart,
      signature,
      status,
      joueur_gagnant,
      mode,
      type_partie,
      ligne_gagnante,
      bga_table_id = null,
      board_size = null
   }) => {
      const [id_partie] = await db('partie')
         .insert({
            mode: mode || 'standard',
            type_partie: type_partie || 'random',
            status: status || 'finished',
            joueur_depart: joueur_depart || null,
            joueur_gagnant: joueur_gagnant || null,
            ligne_gagnante: ligne_gagnante || null,
            signature: signature || null,
            bga_table_id: bga_table_id || null,
            board_size: board_size || null,
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