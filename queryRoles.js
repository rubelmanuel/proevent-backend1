const mysql = require('mysql2');
const db = mysql.createConnection({host: 'localhost', user: 'root', password: '', database: 'uapa_proevent', port: 3307});
db.query('SELECT * FROM rol', (err, results) => {
  if (err) { console.error('Error:', err); process.exit(1); }
  console.log('Roles:', results);
  db.end();
});
