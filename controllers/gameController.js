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
       const { moveSequence, boardRows, boardCols, importedFrom } = req.body;

       // Validate input
       if (!moveSequence || typeof moveSequence !== 'string') {
          return res.status(400).json({
             error: 'moveSequence is required and must be a string'
          });
       }

       if (!boardRows || !boardCols) {
          return res.status(400).json({
             error: 'boardRows and boardCols are required'
          });
       }

       //call game service to save the game
       const result = await gameService.saveGame(
          moveSequence,
          boardRows,
          boardCols,
          importedFrom
       )

       //if erros because of duplicats
       if (!result.success) {
          return res.status(409).json({
             error: 'game already exists',
             existingGame: result.existingGame,
             duplicatType: 'exact'
          })

       }
       //if success
       res.status(201).json({
          message: 'Game saved with success',
          game: result.game,
          isSymmetric: result.isSymmetric,
          symmetricOf: result.symmetricOf
       })
    } catch(error){
      console.error('Error saving the game from the controller: ', error);
      res.status(500).json({
         error:error.message
      })
    }
   }
}