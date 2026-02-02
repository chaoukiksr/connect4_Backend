require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const gameRoutes = require('./routes/games')
app.use('/api/games', gameRoutes);

app.get('/',(req,res)=>{
   res.json({message:'Connect4 api is working '})
})

app.listen(PORT, ()=>{
   console.log('server is working on port: ', PORT);
   
})