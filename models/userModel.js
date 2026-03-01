const db = require('../db/knex');
const table = 'user';
module.exports = {
   createUser:async (username,email,password,role)=>{
      const [id_user] = await db(table).insert({
         username:username,
         email:email,
         password: password,
         role:role
      })
      return db(table).where({ id_user }).first();
   },
   findUserByEmail: async(email)=>{
      if(!email) throw new Error('email is required')
      const user = await  db(table).where({'email':email}).first();
      
      return user;
      
   },
   findUserById : async (id) =>{
      if (!id) throw new Error('id is required')
      const user = await db(table).where({ 'user_id': id }).first();
      return user;
   }
   
}