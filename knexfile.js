// Debug: print DB env variables
require('dotenv').config();
module.exports = {
   client:'mysql2',
   connection:{
      host: "gateway01.eu-central-1.prod.aws.tidbcloud.com",
      user: "tPqNhDuBbqhWTB8.root",
      password: "GWZAPxVGHv4pNM2Q",
      database: "connect4",
      port: 4000,
      ssl: {
          minVersion: 'TLSv1.2',
          rejectUnauthorized: false
      }
   },
   migrations:{
      directory:'./migrations'
   },
   seeds: {
      directory:  './seeds'
   }
}