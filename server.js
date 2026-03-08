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
const userRoutes = require('./routes/user.js')
const bgaRoutes = require('./routes/bga.js')
const suggestRoutes = require('./routes/suggest.js')
const probabilityRoutes = require('./routes/probability.js')

app.use('/api/games', gameRoutes);
app.use('/api', situationRoutes);
app.use('/user', userRoutes);
app.use('/api/bga', bgaRoutes);
app.use('/api/suggest-move', suggestRoutes);
app.use('/api/probability', probabilityRoutes);
app.get('/',(req,res)=>{
   res.json({message:'Connect4 api is working '})
})

app.listen(PORT, ()=>{
   console.log('server is working on port: ', PORT);
   
})