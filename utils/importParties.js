
const { generateSituation } = require('./trainingUtils.js');
const { insertSituations, insertPartie } = require('../models/gameModel.js');
const db = require('../db/knex.js');

const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname,'../../scrapper/data');
const logFile = path.join(__dirname, 'log.txt');
function log(message) {
   console.log(message);
   fs.appendFileSync(logFile, message + '\n');
}
const files = fs.readdirSync(dataDir);
console.log('Scrapped files: ', files);

async function importAll() {
   log('Scrapped files: ' + files.join(', '));
   for (const file of files) {
      const filePath = path.join(dataDir, file);
      const signature = fs.readFileSync(filePath, 'utf-8').trim();
      log(`Signature from ${file}: ${signature}`);
      try {
         const data = await insertPartie(signature);
         log('Inserted partie with ID: ' + JSON.stringify(data));
         const situations = generateSituation(signature);
         const insertedIds = await insertSituations(data.id_partie, situations);
         log('Inserted situation IDs: ' + JSON.stringify(insertedIds));
      } catch (err) {
         log('Test Error: ' + err);
      }
   }
   await db.destroy();
   log('DB connection destroyed. Import finished.');
}
importAll();