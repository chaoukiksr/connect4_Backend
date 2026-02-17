(async () => {
   try {
      const signature = "5555566668923323688566565586889823322338829923322191199911119117747";
      const data = await insertPartie(signature);
      console.log('Inserted partie with ID:', data);
      const situations = generateSituation(signature);

      const insertedIds = await insertSituations(data.id_partie, situations);
      console.log('Inserted situation IDs:', insertedIds);
   } catch (err) {
      console.error('Test Error:', err);
   } finally {
      await db.destroy();
   }
})();
