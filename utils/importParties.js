
const { insertPartie, insertSituations } = require('../models/gameModel.js');
const { generateSituation } = require('./trainingUtils.js');
const { generateMirrorSignature, checkGameExists } = require('./gameUtils.js');
const db = require('../db/knex.js');

const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, '../../scrapper/data');
const logFile = path.join(__dirname, 'log.txt');

function log(message) {
   console.log(message);
   fs.appendFileSync(logFile, message + '\n');
}

function clearLog() {
   fs.writeFileSync(logFile, '');
}

/**
 * Convert player ID to character ('R' or 'Y')
 * If player ID is even → 'R', odd → 'Y', null → null
 */
function convertPlayerIdToChar(playerId) {
   if (playerId === null || playerId === undefined) return null;
   const id = parseInt(String(playerId), 10);
   if (isNaN(id)) return null;
   return id % 2 === 0 ? 'R' : 'Y';
}

/**
 * Parse JSON game file and prepare for DB insertion
 */
function parseGameFile(filePath) {
   try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const gameData = JSON.parse(content);
      
      return {
         signature: gameData.signature || null,
         status: gameData.status || 'finished',
         joueur_depart: convertPlayerIdToChar(gameData.starting_player),
         joueur_gagnant: convertPlayerIdToChar(gameData.winning_player),
         ligne_gagnante: gameData.winning_line ? JSON.stringify(gameData.winning_line) : null,
         mode: 'BGA',
         type_partie: 'scraped'
      };
   } catch (err) {
      throw new Error(`Failed to parse ${path.basename(filePath)}: ${err.message}`);
   }
}

/**
 * Import all games from scrapper/data directory
 */
async function importAll() {
   try {
      clearLog();
      
      // Read all JSON files from data directory
      const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
      log(`Found ${files.length} JSON files to import`);
      log('Files: ' + files.join(', '));
      
      let successCount = 0;
      let errorCount = 0;
      let skipCount = 0;

      for (const file of files) {
         const filePath = path.join(dataDir, file);
         log(`\n--- Processing ${file} ---`);
         
         try {
            // Parse the JSON file
            const gameData = parseGameFile(filePath);
            log(`Parsed: signature=${gameData.signature}, status=${gameData.status}, joueur_depart=${gameData.joueur_depart}, joueur_gagnant=${gameData.joueur_gagnant}`);
            
            // Check if game or its mirror already exists
            const duplicateCheck = await checkGameExists(db, gameData.signature);
            if (duplicateCheck.exists) {
               if (duplicateCheck.type === 'original') {
                  log(`Skipped (duplicate original): Game with signature ${gameData.signature} already exists`);
               } else {
                  log(`Skipped (duplicate mirror): Mirrored game with signature ${duplicateCheck.mirrorSignature} already exists`);
               }
               skipCount++;
               continue;
            }

            // Insert partie
            const partie = await insertPartie(gameData);
            log(`✓ Inserted partie: ID=${partie.id_partie}, signature=${partie.signature}`);
            
            // Generate and insert situations (if signature is valid move sequence)
            if (gameData.signature) {
               try {
                  const situations = generateSituation(gameData.signature);
                  const situationIds = await insertSituations(partie.id_partie, situations);
                  log(`✓ Inserted ${situationIds.length} situations`);
               } catch (situationErr) {
                  log(`⚠ Warning: Could not insert situations: ${situationErr.message}`);
               }
            }
            
            successCount++;
            
         } catch (err) {
            errorCount++;
            log(`✗ Error: ${err.message}`);
         }
      }

      log(`\n=== Import Summary ===`);
      log(`Total files: ${files.length}`);
      log(`Successful: ${successCount}`);
      log(`Skipped (duplicates): ${skipCount}`);
      log(`Errors: ${errorCount}`);
      
   } catch (err) {
      log(`Fatal error: ${err.message}`);
   } finally {
      await db.destroy();
      log('DB connection closed.');
   }
}

// Run the import
importAll();