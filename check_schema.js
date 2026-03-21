const mysql = require('mysql2');
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'uapa_proevent',
  port: 3307
});
db.query('DESCRIBE evento', (err, res) => {
  if (err) console.error(err);
  else {
    res.forEach(row => console.log(row.Field));
  }
  db.end();
});
