/**
 * Migration: Create tables for Connect4 database
 * 
 * Tables:
 * - games: Stocke toutes les parties avec gestion des symétriques
 * - positions: Cache des évaluations minimax (mutualisation)
 * 
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
   return knex.schema
      // =====================================================
      // TABLE: games
      // Description: Stocke toutes les parties de Connect4
      // =====================================================
      .createTable('games', table => {
         // Identifiant unique de la partie
         table.increments('id').primary();
         
         // Séquence des colonnes jouées (ex: "3131313")
         // UNIQUE pour éviter les doublons
         table.string('move_sequence', 100).notNullable().unique();
         
         // Forme canonique pour détecter les symétriques
         // La plus petite entre la séquence et son miroir
         table.string('canonical_sequence', 100).notNullable().index();
         
         // Référence vers la partie symétrique si elle existe
         table.integer('symmetric_game_id').unsigned().nullable();
         
         // Nombre total de coups dans la partie
         table.integer('total_moves').notNullable();
         
         // Statut actuel de la partie
         // 'in_progress': partie en cours
         // 'completed': partie terminée  
         // 'abandoned': partie abandonnée
         table.string('status', 20).defaultTo('completed');
         
         // Résultat de la partie (si terminée)
         // 'player1_wins', 'player2_wins', 'draw', NULL
         table.string('result', 20).nullable();
         
         // Dimensions du plateau
         table.integer('board_rows').defaultTo(6);
         table.integer('board_cols').defaultTo(7);
         
         // Fichier source si importé (ex: "3131313.txt")
         table.string('imported_from', 255).nullable();
         
         // Horodatage
         table.timestamp('created_at').defaultTo(knex.fn.now());
         
         // Clé étrangère vers soi-même pour les symétriques
         table.foreign('symmetric_game_id').references('id').inTable('games')
            .onDelete('SET NULL');
      })

      // =====================================================
      // TABLE: positions (Mutualisation)
      // Description: Cache les évaluations de positions
      // Permet de réutiliser les calculs minimax
      // =====================================================
      .createTable('positions', table => {
         table.increments('id').primary();
         
         // Hash unique de la position du plateau
         table.string('position_hash', 64).notNullable().unique();
         
         // Hash canonique (pour mutualiser les symétriques)
         table.string('canonical_hash', 64).notNullable().index();
         
         // Score minimax calculé
         table.integer('evaluation').notNullable();
         
         // Meilleur coup trouvé
         table.integer('best_move').notNullable();
         
         // Profondeur d'analyse
         table.integer('depth').notNullable();
         
         // Horodatage
         table.timestamp('created_at').defaultTo(knex.fn.now());
      });
};

/**
 * Rollback: Supprime les tables
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
   return knex.schema
      .dropTableIfExists('positions')
      .dropTableIfExists('games');
};
