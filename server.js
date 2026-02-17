require('dotenv').config();
const express = require('express');
const cors = require('cors');
// --- TEST LOGIC: Insert Partie and Situations on server start ---
const { generateSituation } = require('./utils/trainingUtils.js');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const gameRoutes = require('./routes/games')
const situationRoutes = require('./routes/situations');
app.use('/api/games', gameRoutes);
app.use('/api', situationRoutes);

app.get('/',(req,res)=>{
   res.json({message:'Connect4 api is working '})
})

app.listen(PORT, ()=>{
   console.log('server is working on port: ', PORT);
   
})