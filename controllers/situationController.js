const db = require('../db/knex');

module.exports = {
  // Get all situations for a given game (id_partie)
  getByGame: async (req, res) => {
    try {
      const { id } = req.params;
      const situations = await db('situation')
        .where({ id_partie: id })
        .orderBy('numero_coup', 'asc');
      res.json({ situations });
    } catch (error) {
      console.error('Error fetching situations:', error);
      res.status(500).json({ error: error.message });
    }
  }
};
