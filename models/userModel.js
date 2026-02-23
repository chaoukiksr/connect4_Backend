const db = require('../db/knex');
const table = 'user';
module.exports = {
   createUser:async (username,email,password)=>{
      const [id_user] = await db(table).insert({
         username:username,
         email:email,
         password: password
      })
      return db(table).where({ id_user }).first();
   }
}