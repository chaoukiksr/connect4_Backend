/**
 * Migration: Add bga_table_id and board_size to 'partie'
 * - bga_table_id: unique BGA table ID for deduplication
 * - board_size:   stored as "ColsxRows" e.g. "7x6"
 */
exports.up = async function (knex) {
   const hasTable = await knex.schema.hasTable('partie');
   if (!hasTable) return;
   const [hasBgaId, hasBoardSize] = await Promise.all([
      knex.schema.hasColumn('partie', 'bga_table_id'),
      knex.schema.hasColumn('partie', 'board_size'),
   ]);
   if (!hasBgaId) {
      await knex.schema.table('partie', (table) => {
         table.string('bga_table_id', 20).nullable().unique().after('signature');
      });
   }
   if (!hasBoardSize) {
      await knex.schema.table('partie', (table) => {
         table.string('board_size', 10).nullable().defaultTo('7x6');
      });
   }
};

exports.down = function (knex) {
   return knex.schema.hasTable('partie').then((exists) => {
      if (!exists) return;
      return knex.schema.table('partie', (table) => {
         table.dropColumn('bga_table_id');
         table.dropColumn('board_size');
      });
   });
};
