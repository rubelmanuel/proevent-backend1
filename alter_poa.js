const mysql = require('mysql2/promise');

const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'uapa_proevent',
  port: 3307
};

async function run() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('Conectado a la base de datos.');

    // 1. Crear Rol si no existe
    const [roles] = await connection.query("SELECT id_rol FROM rol WHERE nombre = 'Administrador V-A-F'");
    if (roles.length === 0) {
      await connection.query("INSERT INTO rol (nombre) VALUES ('Administrador V-A-F')");
      console.log("✅ Rol 'Administrador V-A-F' insertado.");
    } else {
      console.log("✅ Rol 'Administrador V-A-F' ya existía.");
    }

    // 2. Tabla poa_fiscal
    await connection.query(`
      CREATE TABLE IF NOT EXISTS poa_fiscal (
          id_poa INT AUTO_INCREMENT PRIMARY KEY,
          fecha_inicio DATE NOT NULL,
          fecha_fin DATE NOT NULL,
          monto_total DECIMAL(15,2) NOT NULL,
          monto_disponible DECIMAL(15,2) NOT NULL,
          creado_por INT,
          fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (creado_por) REFERENCES usuario(id_usuario) ON DELETE SET NULL
      )
    `);
    console.log("✅ Tabla poa_fiscal verificada/creada.");

    // 3. Tabla poa_movimiento
    await connection.query(`
      CREATE TABLE IF NOT EXISTS poa_movimiento (
          id_movimiento INT AUTO_INCREMENT PRIMARY KEY,
          id_poa INT NOT NULL,
          id_evento INT NOT NULL,
          monto_solicitado_original DECIMAL(15,2) NOT NULL,
          moneda_original VARCHAR(10) NOT NULL,
          tasa_cambio DECIMAL(10,4) NOT NULL,
          monto_descontado_dop DECIMAL(15,2) NOT NULL,
          estado ENUM('Pendiente', 'Aprobado', 'Rechazado') DEFAULT 'Pendiente',
          motivo_rechazo TEXT,
          fecha_movimiento DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (id_poa) REFERENCES poa_fiscal(id_poa) ON DELETE CASCADE,
          FOREIGN KEY (id_evento) REFERENCES evento(id_evento) ON DELETE CASCADE
      )
    `);
    console.log("✅ Tabla poa_movimiento verificada/creada.");

  } catch (error) {
    console.error('❌ Error en alteración de BD:', error);
  } finally {
    if (connection) await connection.end();
  }
}

run();
