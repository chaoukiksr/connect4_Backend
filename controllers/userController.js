const {hash,genSalt,compare} = require('bcrypt');
const { createUser } = require('../models/userModel');
const userModel = require('../models/userModel');
const jwt = require('jsonwebtoken');
require('dotenv').config();
module.exports = {
   registre: async(req,res)=>{
      const {username,email,password,role} = req.body;
      const user = await userModel.findUserByEmail(email);

      if(user){
         console.log(user);
         
         return res.status(409).json({message:"user already exists"})
      }

      const salt = await genSalt(10);
      const hashedPassword = await hash(password, salt);
      const response = await createUser(username,email,hashedPassword,role);
      res.status(201).json({message:"success creating the user", userId:response.id})

   },
   login: async(req,res) =>{
      const {email,password} = req.body;
      const user= await userModel.findUserByEmail(email);
      
      if (user){
         if(await compare(password,user.password)){
            console.log(user);
            if(!process.env.SECRET) throw new Error('SECRET is not defind');

            const token = jwt.sign({
               id:user.user_id,
               role:user.role
            },
            process.env.SECRET,
            {
               expiresIn:'1 day'
            }
         )
         console.log(token);
         // Return role in response for frontend redirect
         return res.status(200).json({message:"loged in", token:token, role: user.role});
         }
      }
      return res.status(401).json({message:"Invalid credintials"})
   },
   getPersonalSpace:async (req, res) => {
      const role = req.user.role
      const userId = req.user.id;
      if(!userId) throw new Error ('userId is required')
         try {
      const user = await userModel.findUserById(userId);
         if(role == 'admin') return res.status(200).json({user:user, message:"welcome Admin"})
         if(!user) console.log('user doesn not exist')
         return res.status(200).json({ user: user });

      } catch (error) {
         return res.status(401).json({message:"access is forbiden"})         
      }
    }
}