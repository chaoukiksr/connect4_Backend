const {hash,genSalt} = require('bcrypt');
const { createUser } = require('../models/userModel');
module.exports = {
   registre: async(req,res)=>{
      const {username,email,password} = req.body;
      const salt = await genSalt(10);
      const hashedPassword = await hash(password, salt);
      const response = await createUser(username,email,hashedPassword);
      res.status(200).json({message:"success creating the user", userId:response.id})
   }
}