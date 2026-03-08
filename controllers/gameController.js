const gameService = require('../services/gameService');

module.exports = {
   getAll: async (req, res) => {
      try{
         const games = await gameService.getAllGames();
         res.json({games});
      } catch(error){
         console.error('Error fetching games from the controller', error);
         res.status(500).json({
            error:error.message
         })
      }
   },
   create : async(req,res) =>{
    try {
       const { signature, startingPlayer, mode, type_partie, status, winner, ligne_gagnante,
               bga_table_id, board_size } = req.body;

       // Validate input
       if (!signature || typeof signature !== 'string') {
          return res.status(400).json({
             error: 'signature is required and must be a string'
          });
       }

       if (!mode || typeof mode !== 'string') {
          return res.status(400).json({
             error: 'mode is required and must be a string'
          });
       }

       // Provide default status if missing
       const finalStatus = status && typeof status === 'string' ? status : 'finished';

       const result = await gameService.saveGame(
          signature,
          mode,
          type_partie || 'random',
          finalStatus,
          startingPlayer,
          winner,
          ligne_gagnante,
          bga_table_id || null,
          board_size || null
       );

       // If error because of duplicates
       if (!result.success) {
          return res.status(409).json({
             error: result.error,
             duplicateType: result.duplicateType,
             existingGame: result.existingGame,
             mirrorSignature: result.mirrorSignature
          });
       }

       // If success
       res.status(201).json({
          message: 'Game saved with success',
          game: result.game
       });
    } catch(error){
      console.error('Error saving the game from the controller: ', error);
      res.status(500).json({
         error: error.message
      });
    }
   },

   getStats: async (req, res) => {
      try {
         const stats = await gameService.getStats();
         res.json(stats);
      } catch (error) {
         console.error('Error fetching stats:', error);
         res.status(500).json({ error: error.message });
      }
   },

   getById: async (req, res) => {
      try {
         const game = await gameService.getById(Number(req.params.id));
         if (!game) return res.status(404).json({ error: 'Game not found' });
         res.json({ game });
      } catch (error) {
         res.status(500).json({ error: error.message });
      }
   },

   deleteGame: async (req, res) => {
      try {
         await gameService.deleteGame(Number(req.params.id));
         res.json({ message: 'Game deleted' });
      } catch (error) {
         res.status(500).json({ error: error.message });
      }
   }
}