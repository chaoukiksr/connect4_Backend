/**
 * Migration: Create tables for Connect4 database
 * Tables:
 * - partie
 * - situation
 */

const { table } = require("../db/knex");

exports.up = function (knex) {
   return knex.schema
      .createTable('user', table => {
         table.increments('id_user').primary();
         table.string('username', 30).notNullable();
         table.string('email',50).notNullable();
         table.string('password', 60).notNullable();
         table.enu('role', ['user','admin'],{
            useNative:true,
            enumName:'user_role'
         }).notNullable().defaultTo('user');
   })
      // ============================================
      // TABLE: partie
      // ============================================
      .createTable('partie', table => {
         table.increments('id_partie').primary(); // SERIAL PRIMARY KEY

         table.string('mode', 20).notNullable();
         table.string('type_partie', 20).nullable();
         table.string('status', 20).notNullable();

         table.string('joueur_depart', 1).nullable();
         table.string('joueur_gagnant', 1).nullable();

         table.text('ligne_gagnante').nullable();

         table.string('signature', 255).unique();


         table.timestamp('created_at').defaultTo(knex.fn.now());
      })

      // ============================================
      // TABLE: situation
      // ============================================
      .createTable('situation', table => {
         table.increments('id_situation').primary();

         table.integer('id_partie')
            .unsigned()
            .references('id_partie')
            .inTable('partie')
            .onDelete('CASCADE');

         table.integer('numero_coup').notNullable();

         table.text('plateau').notNullable();

         table.string('joueur', 1).nullable();

         table.integer('precedent').nullable();
         table.integer('suivant').nullable();
      });
      
      
};

exports.down = function (knex) {
   return knex.schema
      .dropTableIfExists('situation')
      .dropTableIfExists('partie');
};
