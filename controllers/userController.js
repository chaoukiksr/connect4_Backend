const {hash,genSalt,compare} = require('bcrypt');
const { createUser } = require('../models/userModel');
const userModel = require('../models/userModel');
module.exports = {
   registre: async(req,res)=>{
      const {username,email,password,role} = req.body;
      const salt = await genSalt(10);
      const hashedPassword = await hash(password, salt);
      const response = await createUser(username,email,hashedPassword,role);
      res.status(200).json({message:"success creating the user", userId:response.id})
   },
   login: async(req,res) =>{
      const {email,password} = req.body;
      const user= await userModel.findUser(email);
      if (user){
         if(await compare(password,user.password)){
            return res.status(200).json({message:"loged in", token:"1111"});
         }
           return res.status(400).json({message:"password is incorrect"})
      }
      return res.status(400).json({message:"user does not exist, go to sign up page"})
   }
}