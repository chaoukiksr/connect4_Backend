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
       const { signature, startingPlayer, mode, type_partie, status, winner, ligne_gagnante } = req.body;

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

       // Call game service to save the game
       console.log('from the controller', signature,
          mode,
          type_partie,
          finalStatus,
          startingPlayer,
          winner,
          ligne_gagnante);
       
       const result = await gameService.saveGame(
          signature,
          mode,
          type_partie || 'random',
          finalStatus,
          startingPlayer,
          winner,
          ligne_gagnante
       );

       // If error because of duplicates
       if (!result.success) {
          return res.status(409).json({
             error: 'game already exists',
             existingGame: result.existingGame,
             duplicateType: 'exact'
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
   }
}