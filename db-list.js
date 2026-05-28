const mysql = require('mysql2');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  port: 3307
});

db.connect(err => {
  if (err) { console.error(err); return; }
  db.query('SHOW DATABASES', (err, results) => {
    if (err) { console.error(err); return; }
    console.log("DATABASES:", results);
    db.end();
  });
});
