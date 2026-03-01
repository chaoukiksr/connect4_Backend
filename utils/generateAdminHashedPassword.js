const bcrypt = require('bcrypt');
const generate =( async () =>{
   const salt = await bcrypt.genSalt(10);
   const hashedPassword = await bcrypt.hash("chaouki", salt);
   console.log(hashedPassword);
})();
