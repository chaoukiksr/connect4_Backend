require('dotenv').config();
const jwt = require('jsonwebtoken');

const auth = (req,res,next) =>{
   const headers = req.headers.authorization;
   if(!headers) return res.status(401).json({message:"invalid headers"});
   const token = headers.split(' ')[1];

   try {
      const decoded = jwt.verify(token,process.env.SECRET );
      req.user = decoded;
      next();
   } catch (error) {
      return res.status(403).json({ message: "access is Forbidden"});
   }
}

module.exports = auth;