// seedData.js – script to populate essential data for ProEvent backend
const mysql = require('mysql2');
require('dotenv').config();
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'uapa_proevent',
  port: 3307,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

const roles = [
  'Administrador',
  'Desarrollador',
  'Solicitante',
  'Administrador de Audiovisual',
  'Administrador de Evento',
  'Administrador V-A-F',
];

const insertRoles = () => new Promise((resolve, reject) => {
  const placeholders = roles.map(() => '(?)').join(',');
  const sql = `INSERT IGNORE INTO rol (nombre) VALUES ${placeholders}`;
  db.query(sql, roles, (err) => {
    if (err) return reject(err);
    resolve();
  });
});

const insertTestUser = () => new Promise((resolve, reject) => {
  const sql = `INSERT IGNORE INTO usuario (nombre, correo, contrasena, id_rol) VALUES (?, ?, ?, (SELECT id_rol FROM rol WHERE nombre = ?))`;
  const values = ['Rubel Manuel', 'rubelmanuelc@gmail.com', '123456789', 'Administrador'];
  db.query(sql, values, (err) => {
    if (err) return reject(err);
    resolve();
  });
});

(async () => {
  try {
    await insertRoles();
    console.log('Roles insertados o existentes.');
    await insertTestUser();
    console.log('Usuario de prueba creado o ya existía.');
    process.exit(0);
  } catch (e) {
    console.error('Error al sembrar datos:', e);
    process.exit(1);
  }
})();
