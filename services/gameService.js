const gameModel = require('../models/gameModel');
const { getCanonicalSequence, analyzeGame } = require('../utils/gameUtils');

module.exports = {
   //get all games
   getAllGames: async () =>{
      return gameModel.findAll();
   },
   saveGame : async (moveSequence, startingPlayer, boardRows, boardCols, importedFrom = null) =>{
      //check for duplicat game
      const existingGame = await gameModel.findByMoveSequesnce(moveSequence);
      if(existingGame) {
         return {
            success:false,
            error:'game duplication error',
            existingGame:existingGame
         }
      }

      // calculate canonical form of the game
      const canonicalSequence = getCanonicalSequence(moveSequence,boardCols);
      console.log('canonicalSequence from the service: ', canonicalSequence);
      
      // check for symetric game existens
      const symmetricGame = await gameModel.findByCanonical(canonicalSequence);

      // analyze the game

      const {status, result} = analyzeGame(moveSequence,startingPlayer, boardRows, boardCols);

      //save the game

      const newGame = await gameModel.createGame({
         move_sequence: moveSequence,
         starting_player:startingPlayer,
         canonical_sequence: canonicalSequence,
         symmetric_game_id: symmetricGame ?  symmetricGame.id : null,
         total_moves: moveSequence.length,
         status, 
         result,
         board_rows: boardRows,
         board_cols: boardCols,
         imported_from: importedFrom
      })

      //link back if symetric doesn't exist
      if (symmetricGame && !symmetricGame.symmetric_game_id){
         await gameModel.updateGame(symmetricGame.id, {
            symmetric_game_id:newGame.id
         })
      }

      //

      return {
         success: true,
         game: newGame,
         isSymmetric: !!symmetricGame,
         symmetricOf: symmetricGame ? symmetricGame.id : null
      }
   }
}