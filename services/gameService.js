const gameModel = require('../models/gameModel');
const { getCanonicalSequence, analyzeGame } = require('../utils/gameUtils');

module.exports = {
   //get all games
   getAllGames: async () =>{
      return gameModel.findAll();
   },
   saveGame: async (
      signature,
      mode,
      type_partie,
      status,
      joueur_depart,
      joueur_gagnant,
      ligne_gagnante
   )=>{
      console.log('from the service:',signature,
         mode,
         type_partie,
         status,
         joueur_depart,
         joueur_gagnant,
         ligne_gagnante);
      
      // Convert player numbers/strings to single character: 1/'red'/'R' -> 'R', 2/'yellow'/'Y' -> 'Y'
      const convertPlayer = (player) => {
         if (player === 1 || player === '1' || player?.toLowerCase?.() === 'red' || player === 'R') return 'R';
         if (player === 2 || player === '2' || player?.toLowerCase?.() === 'yellow' || player === 'Y') return 'Y';
         return null;
      };

      // Ensure signature is a valid string
      let finalSignature = signature;
      if (typeof signature !== 'string') {
         if (Array.isArray(signature)) {
            finalSignature = signature.join('');
         } else if (typeof signature === 'object') {
            finalSignature = JSON.stringify(signature);
         } else {
            finalSignature = String(signature);
         }
      }
      
      // Validate signature is not empty and not too long
      if (!finalSignature || finalSignature.length === 0) {
         throw new Error('Invalid signature: cannot be empty');
      }
      if (finalSignature.length > 255) {
         throw new Error(`Invalid signature: too long (${finalSignature.length} chars, max 255)`);
      }

      // Check if game already exists
      const existingGame = await gameModel.findBySignature(finalSignature);
      if (existingGame) {
         return {
            success: false,
            existingGame
         };
      }

      // Ensure mode and type_partie are strings
      const validatedMode = typeof mode === 'string' ? mode : (mode ? String(mode) : 'standard');
      const validatedTypePart = typeof type_partie === 'string' ? type_partie : (type_partie ? String(type_partie) : 'random');
      const validatedStatus = typeof status === 'string' ? status : 'finished';

      // Ensure ligne_gagnante is either null or a proper JSON string
      let finalLigneGagnante = ligne_gagnante;
      if (finalLigneGagnante !== null && finalLigneGagnante !== undefined) {
         if (typeof finalLigneGagnante !== 'string') {
            finalLigneGagnante = JSON.stringify(finalLigneGagnante);
         }
      }

      const newGame = await gameModel.insertPartie({
         joueur_depart: convertPlayer(joueur_depart),
         signature: finalSignature,
         status: validatedStatus,
         joueur_gagnant: convertPlayer(joueur_gagnant),
         mode: validatedMode,
         type_partie: validatedTypePart,
         ligne_gagnante: finalLigneGagnante
      });

      return {
         success: true,
         game: newGame
      };
   }
}