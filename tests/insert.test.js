require('dotenv').config();
const db = require('../db/knex.js'); // your knex instance
const { generateSituation } = require('../utils/trainingUtils.js')
const {  insertSituations,insertPartie } = require('../models/gameModel.js');
 // path to your model file

   (async () => {
      try {
         const signature = "5555566668923323688566565586889823322338829923322191199911119117747";
         const id_partie = await insertPartie()

         console.log('Inserted partie with ID:', id_partie);

         // 2️⃣ Generate situations
         const situations = generateSituation(signature);
         console.log('Generated situations:', situations);

         // 3️⃣ Insert situations into DB
         const insertedIds = await insertSituations(id_partie, situations);
         console.log('Inserted situation IDs:', insertedIds);

      } catch (err) {
         console.error('Error:', err);
      } finally {
         await db.destroy(); // close connection
      }
   })();