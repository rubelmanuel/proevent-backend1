const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const GOOGLE_CLIENT_ID = '426335318098-v39ood0lcapc22lgoq3lons62hbf507m.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'uapa_proevent',
  port: 3307,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection((err, connection) => {
  if (err) {
    console.log('Error conectando a MySQL:', err);
    return;
  }
  if (connection) connection.release();
  console.log('✅ Conectado a MySQL correctamente (Pool)');

  // Asegurar que la tabla de tokens existe
  const createTokensTable = `
    CREATE TABLE IF NOT EXISTS restablecimiento_token (
      id_token INT AUTO_INCREMENT PRIMARY KEY,
      correo VARCHAR(120) NOT NULL,
      token VARCHAR(255) NOT NULL,
      expiracion DATETIME NOT NULL
    )
  `;
  db.query(createTokensTable, (err) => {
    if (err) console.error('Error al crear la tabla de tokens:', err);
    else console.log('✅ Tabla de tokens verificada/creada');
  });

  // Asegurar que la tabla de evaluaciones existe
  const createEvalTable = `
    CREATE TABLE IF NOT EXISTS evaluacion (
      id_evaluacion INT AUTO_INCREMENT PRIMARY KEY,
      id_evento INT NOT NULL,
      respuesta_solicitud ENUM('Si','No'),
      recinto ENUM('Cibao Oriental','Nagua','Santo Domingo Oriental','Santiago'),
      valoracion_respuesta ENUM('Muy eficiente','Excelente','Eficiente','Deficiente'),
      satisfaccion INT CHECK (satisfaccion BETWEEN 1 AND 5),
      comentario TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_evento) REFERENCES evento(id_evento) ON DELETE CASCADE
    )
  `;
  db.query(createEvalTable, (err) => {
    if (err) console.error('Error al crear la tabla de evaluaciones:', err);
    else console.log('✅ Tabla de evaluaciones verificada/creada');
  });
});

// HELPER: Registrar Movimiento en Bitácora
function registrarMovimiento(id_usuario, id_rol, accion, detalles = '') {
  if (!id_usuario) return;
  
  const registrar = (id_usr, id_rl) => {
    const sql = 'INSERT INTO bitacora_movimiento (id_usuario, id_rol, accion, detalles) VALUES (?, ?, ?, ?)';
    db.query(sql, [id_usr, id_rl, accion, detalles], (err) => {
      if (err) console.error('Error registrando bitácora:', err);
    });
  };

  if (!id_rol) {
    db.query('SELECT id_rol FROM usuario WHERE id_usuario = ?', [id_usuario], (err, res) => {
      if (!err && res.length > 0) registrar(id_usuario, res[0].id_rol);
    });
  } else {
    registrar(id_usuario, id_rol);
  }
}

// LOGIN
app.post('/login', (req, res) => {
  const { correo, contrasena } = req.body;
  db.query(
    `SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
     FROM usuario u
     JOIN rol r ON u.id_rol = r.id_rol
     WHERE u.correo = ? AND u.contrasena = ?`,
    [correo, contrasena],
    (err, results) => {
      if (err) return res.status(500).json({ mensaje: 'Error del servidor' });
      if (results.length === 0) {
        return res.status(401).json({ mensaje: 'Correo o contraseña incorrectos' });
      }
      const usuarioData = results[0];
      res.json({ mensaje: 'Login exitoso', usuario: usuarioData });
      registrarMovimiento(usuarioData.id_usuario, usuarioData.id_rol, 'LOGIN', `Sesión Inicada (Manual). Autenticado como ${usuarioData.nombre} (${correo}) bajo el rol de ${usuarioData.rol}.`);
    }
  );
});

// LOGIN CON GOOGLE
app.post('/login-google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ mensaje: 'Falta el token de Google' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const correo = payload.email;

    db.query(
      `SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
       FROM usuario u
       JOIN rol r ON u.id_rol = r.id_rol
       WHERE u.correo = ?`,
      [correo],
      (err, results) => {
        if (err) return res.status(500).json({ mensaje: 'Error del servidor' });
        if (results.length === 0) {
          // Si el correo no existe en la base de datos
          return res.status(403).json({ mensaje: 'Correo no registrado en el sistema. Contacte al administrador.' });
        }
        // Éxito, el correo está registrado
        const usuarioData = results[0];
        res.json({ mensaje: 'Login exitoso', usuario: usuarioData });
        registrarMovimiento(usuarioData.id_usuario, usuarioData.id_rol, 'LOGIN_GOOGLE', `Sesión Inicada (Google OAuth). Autenticado como ${usuarioData.nombre} (${correo}) bajo el rol de ${usuarioData.rol}.`);
      }
    );
  } catch (error) {
    console.error('Error verificando token de Google:', error);
    res.status(401).json({ mensaje: 'Token de Google inválido' });
  }
});

// OBTENER todos los usuarios con su rol
app.get('/usuarios', (req, res) => {
  db.query(
    `SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
     FROM usuario u
     JOIN rol r ON u.id_rol = r.id_rol`,
    (err, results) => {
      if (err) return res.status(500).json({ error: err });
      res.json(results);
    }
  );
});

// OBTENER la bitácora de movimientos
app.get('/bitacora', (req, res) => {
  const query = `
    SELECT 
      b.id_bitacora, 
      b.id_usuario,
      u.nombre AS nombre_usuario, 
      r.nombre AS rol_usuario, 
      b.accion, 
      b.detalles, 
      b.fecha
    FROM bitacora_movimiento b
    LEFT JOIN usuario u ON b.id_usuario = u.id_usuario
    LEFT JOIN rol r ON b.id_rol = r.id_rol
    ORDER BY b.fecha DESC;
  `;
  db.query(query, (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

// OBTENER todos los roles disponibles
app.get('/roles', (req, res) => {
  db.query('SELECT * FROM rol', (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

// CREAR un nuevo usuario
app.post('/usuarios', (req, res) => {
  const { nombre, correo, contrasena, id_rol } = req.body;
  if (!nombre || !correo || !contrasena || !id_rol) {
    return res.status(400).json({ mensaje: 'Todos los campos son obligatorios' });
  }
  db.query(
    'INSERT INTO usuario (nombre, correo, contrasena, id_rol) VALUES (?, ?, ?, ?)',
    [nombre, correo, contrasena, id_rol],
    (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ mensaje: 'El correo ya está registrado' });
        }
        return res.status(500).json({ mensaje: 'Error al crear usuario', error: err });
      }
      res.status(201).json({ mensaje: 'Usuario creado con éxito', id: result.insertId });
      
      const adminId = req.headers['x-usuario-id'];
      if(adminId) registrarMovimiento(adminId, null, 'CREACION_USUARIO', `Registro de nuevo usuario. ID asignado: ${result.insertId}, Nombre: ${nombre}, Correo: ${correo}, Nivel de Rol ID: ${id_rol}.`);
    }
  );
});

// ACTUALIZAR un usuario
app.put('/usuarios/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, correo, contrasena, id_rol } = req.body;

  if (contrasena && contrasena.trim() !== '') {
    db.query(
      'UPDATE usuario SET nombre = ?, correo = ?, contrasena = ?, id_rol = ? WHERE id_usuario = ?',
      [nombre, correo, contrasena, id_rol, id],
      (err) => {
        if (err) return res.status(500).json({ mensaje: 'Error al actualizar usuario', error: err });
        res.json({ mensaje: 'Usuario actualizado con éxito' });
        const adminId = req.headers['x-usuario-id'];
        if(adminId) registrarMovimiento(adminId, null, 'ACTUALIZACION_USUARIO', `Modificación de Perfil. ID afectado: ${id}. Nuevos datos -> Nombre: ${nombre}, Correo: ${correo}, Rol ID: ${id_rol}. (Contraseña modificada)`);
      }
    );
  } else {
    db.query(
      'UPDATE usuario SET nombre = ?, correo = ?, id_rol = ? WHERE id_usuario = ?',
      [nombre, correo, id_rol, id],
      (err) => {
        if (err) return res.status(500).json({ mensaje: 'Error al actualizar usuario', error: err });
        res.json({ mensaje: 'Usuario actualizado con éxito' });
        const adminId = req.headers['x-usuario-id'];
        if(adminId) registrarMovimiento(adminId, null, 'ACTUALIZACION_USUARIO', `Modificación de Perfil. ID afectado: ${id}. Nuevos datos -> Nombre: ${nombre}, Correo: ${correo}, Rol ID: ${id_rol}. (Sin alterar contraseña)`);
      }
    );
  }
});

// ELIMINAR un usuario
app.delete('/usuarios/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM usuario WHERE id_usuario = ?', [id], (err) => {
    if (err) return res.status(500).json({ mensaje: 'Error al eliminar usuario', error: err });
    res.json({ mensaje: 'Usuario eliminado con éxito' });
    const adminId = req.headers['x-usuario-id'];
    if(adminId) registrarMovimiento(adminId, null, 'ELIMINACION_USUARIO', `Eliminación permanente de cuenta de usuario. ID del usuario erradicado: ${id}.`);
  });
});
// OBTENER dependencias
app.get('/dependencias', (req, res) => {
  db.query('SELECT * FROM dependencia', (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

// OBTENER recintos
app.get('/recintos', (req, res) => {
  db.query('SELECT * FROM recinto', (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

// CREAR evento
app.post('/eventos', async (req, res) => {
  const {
    nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin,
    cantidad_asistentes, tipo_evento, monto_poa, moneda,
    id_usuario, id_dependencia, id_recinto,
    detalles_corporativos, alimentos, observaciones
  } = req.body;

  let tasa_cambio = 1;
  let monto_dop = 0;
  
  const montoPOA = parseFloat(monto_poa) || 0;

  if (montoPOA > 0) {
    if (moneda && moneda !== 'DOP') {
      try {
        const fetchRes = await fetch(`https://open.er-api.com/v6/latest/${moneda}`);
        const data = await fetchRes.json();
        tasa_cambio = data.rates.DOP || 1;
      } catch (err) {
        console.error("Error al obtener tasa de cambio:", err);
      }
    }
    monto_dop = montoPOA * tasa_cambio;
  }

  // Comprobar si hay un POA activo para deducir
  let id_poa_activo = null;
  if (montoPOA > 0) {
    try {
      const dbPromise = db.promise();
      const [poas] = await dbPromise.query(
        "SELECT id_poa, monto_disponible FROM poa_fiscal WHERE fecha_inicio <= ? AND fecha_fin >= ? ORDER BY id_poa DESC LIMIT 1",
        [fecha_inicio, fecha_inicio]
      );
      if (poas.length > 0) {
        id_poa_activo = poas[0].id_poa;
        if (parseFloat(poas[0].monto_disponible) < monto_dop) {
          return res.status(400).json({ mensaje: 'Presupuesto POA insuficiente para este monto en la fecha del evento.' });
        }
      } else {
        return res.status(400).json({ mensaje: 'No hay un año fiscal registrado que coincida con la fecha del evento para asignar POA.' });
      }
    } catch (err) {
      return res.status(500).json({ mensaje: 'Error verificando POA', error: err.message });
    }
  }

  db.query(
    `INSERT INTO evento (nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin,
      cantidad_asistentes, tipo_evento, monto_poa, moneda, id_usuario, id_dependencia, id_recinto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin,
      cantidad_asistentes, tipo_evento, monto_poa, moneda, id_usuario, id_dependencia, id_recinto],
    (err, result) => {
      if (err) return res.status(500).json({ mensaje: 'Error al crear evento', error: err });

      const id_evento = result.insertId;

      if (detalles_corporativos && detalles_corporativos.length > 0) {
        const valoresCorp = detalles_corporativos.map(tipo => [id_evento, tipo]);
        db.query('INSERT INTO detalle_corporativo (id_evento, tipo) VALUES ?', [valoresCorp], () => { });
      }

      if (alimentos && alimentos.length > 0) {
        db.query('SELECT id_alimento, nombre FROM alimento', (err2, alimentosDB) => {
          if (!err2) {
            const valores = [];
            alimentos.forEach(nombreAlimento => {
              const encontrado = alimentosDB.find(a => a.nombre === nombreAlimento);
              if (encontrado) valores.push([id_evento, encontrado.id_alimento]);
            });
            if (valores.length > 0) {
              db.query('INSERT INTO evento_alimento (id_evento, id_alimento) VALUES ?', [valores], () => { });
            }
          }
        });
      }

      if (observaciones && observaciones.trim() !== '') {
        db.query('INSERT INTO detalle_montaje (id_evento, descripcion) VALUES (?, ?)', [id_evento, observaciones], () => { });
      }

      if (montoPOA > 0 && id_poa_activo) {
        db.query(
          `INSERT INTO poa_movimiento (id_poa, id_evento, monto_solicitado_original, moneda_original, tasa_cambio, monto_descontado_dop, estado)
           VALUES (?, ?, ?, ?, ?, ?, 'Pendiente')`,
          [id_poa_activo, id_evento, montoPOA, moneda || 'DOP', tasa_cambio, monto_dop],
          (poaErr) => {
            if (!poaErr) {
               db.query("UPDATE poa_fiscal SET monto_disponible = monto_disponible - ? WHERE id_poa = ?", [monto_dop, id_poa_activo], ()=>{});
            }
          }
        );
      }

      res.status(201).json({ mensaje: 'Evento creado con éxito', id_evento });
      const reqUserId = req.headers['x-usuario-id'] || id_usuario;
      if(reqUserId) registrarMovimiento(reqUserId, null, 'CREACION_EVENTO', `Nueva Solicitud de Evento. ID generado: ${id_evento}. Título: "${nombre}".`);
    }
  );
});

// ── PLAN OPERATIVO ANUAL (POA) ─────────────────────────
app.post('/poa', (req, res) => {
  const { fecha_inicio, fecha_fin, monto_total } = req.body;
  if (!fecha_inicio || !fecha_fin || !monto_total) return res.status(400).json({ mensaje: 'Datos incompletos.' });

  const reqUserId = req.headers['x-usuario-id'] || null;

  db.query(
    'INSERT INTO poa_fiscal (fecha_inicio, fecha_fin, monto_total, monto_disponible, creado_por) VALUES (?, ?, ?, ?, ?)',
    [fecha_inicio, fecha_fin, monto_total, monto_total, reqUserId],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ mensaje: 'POA Creado', id_poa: result.insertId });
      if(reqUserId) registrarMovimiento(reqUserId, null, 'CREACION_POA', `Nuevo presupuesto POA por ${monto_total}.`);
    }
  );
});

app.get('/poa', (req, res) => {
  db.query('SELECT * FROM poa_fiscal ORDER BY fecha_inicio DESC', (err, poas) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.query(`
      SELECT m.*, e.nombre as nombre_evento, e.modalidad, e.fecha_inicio, e.fecha_fin,
             e.hora_inicio, e.hora_fin, e.cantidad_asistentes, e.tipo_evento,
             u.nombre as solicitante, r.nombre as recinto
      FROM poa_movimiento m
      JOIN evento e ON m.id_evento = e.id_evento
      LEFT JOIN usuario u ON e.id_usuario = u.id_usuario
      LEFT JOIN recinto r ON e.id_recinto = r.id_recinto
      ORDER BY m.fecha_movimiento DESC
    `, (errMov, movs) => {
      if (errMov) return res.status(500).json({ error: errMov.message });
      res.json({ poas, movimientos: movs });
    });
  });
});

app.put('/poa/movimiento/:id/estado', (req, res) => {
  const { id } = req.params;
  const { estado, motivo_rechazo } = req.body; 
  const reqUserId = req.headers['x-usuario-id'];

  db.query('SELECT * FROM poa_movimiento WHERE id_movimiento = ?', [id], (err, results) => {
    if (err || results.length === 0) return res.status(404).json({ mensaje: 'Movimiento no encontrado' });
    
    const mov = results[0];
    if (mov.estado === estado) return res.json({ mensaje: 'Sin cambios en el estado' });

    db.query('UPDATE poa_movimiento SET estado = ?, motivo_rechazo = ? WHERE id_movimiento = ?', 
      [estado, motivo_rechazo || null, id], 
      (errUpdate) => {
        if (errUpdate) return res.status(500).json({ error: errUpdate.message });
        
        // Si el estado anterior no era Rechazado y ahora es Rechazado, devolver dinero.
        if (estado === 'Rechazado' && mov.estado !== 'Rechazado') {
          db.query('UPDATE poa_fiscal SET monto_disponible = monto_disponible + ? WHERE id_poa = ?', [mov.monto_descontado_dop, mov.id_poa]);
        }
        // Si el estado anterior era Rechazado y ahora es Aprobado/Pendiente, volver a restar dinero.
        else if (mov.estado === 'Rechazado' && estado !== 'Rechazado') {
          db.query('UPDATE poa_fiscal SET monto_disponible = monto_disponible - ? WHERE id_poa = ?', [mov.monto_descontado_dop, mov.id_poa]);
        }

        res.json({ mensaje: 'Estado del movimiento POA actualizado' });
        if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_POA', `Movimiento ${id} cambiado a ${estado}.`);
    });
  });
});
app.put('/eventos/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin, cantidad_asistentes, tipo_evento, id_recinto, id_dependencia, detalles_corporativos, alimentos, observaciones, monto_poa, moneda } = req.body;
  const reqUserId = req.headers['x-usuario-id'];

  const sql = `UPDATE evento SET 
    nombre = ?, modalidad = ?, fecha_inicio = ?, fecha_fin = ?, 
    hora_inicio = ?, hora_fin = ?, cantidad_asistentes = ?, 
    tipo_evento = ?, id_recinto = ?, id_dependencia = ?,
    monto_poa = ?, moneda = ?
    WHERE id_evento = ?`;
  
  if (!id_recinto || !id_dependencia) {
    return res.status(400).json({ mensaje: 'Faltan campos obligatorios: Recinto o Dependencia.' });
  }

  const params = [nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin, cantidad_asistentes, tipo_evento, id_recinto, id_dependencia, monto_poa, moneda, id];

  db.query(sql, params, (err) => {
    if (err) {
      console.error('SQL Error en PUT /eventos:', err.message);
      console.error('Params:', params);
      return res.status(500).json({ mensaje: 'Error al actualizar evento', error: err.message });
    }
    
    // Actualizar Detalle Corporativo
    db.query('DELETE FROM detalle_corporativo WHERE id_evento = ?', [id], () => {
      if (detalles_corporativos && detalles_corporativos.length > 0) {
        const valoresCorp = detalles_corporativos.map(tipo => [id, tipo]);
        db.query('INSERT INTO detalle_corporativo (id_evento, tipo) VALUES ?', [valoresCorp], () => { });
      }
    });

    // Actualizar Alimentos
    db.query('DELETE FROM evento_alimento WHERE id_evento = ?', [id], () => {
      if (alimentos && alimentos.length > 0) {
        db.query('SELECT id_alimento, nombre FROM alimento', (err2, alimentosDB) => {
          if (!err2) {
            const valores = [];
            alimentos.forEach(nombreAlimento => {
              const encontrado = alimentosDB.find(a => a.nombre === nombreAlimento);
              if (encontrado) valores.push([id, encontrado.id_alimento]);
            });
            if (valores.length > 0) {
              db.query('INSERT INTO evento_alimento (id_evento, id_alimento) VALUES ?', [valores], () => { });
            }
          }
        });
      }
    });

    // Actualizar Observaciones (Detalle Montaje)
    db.query('DELETE FROM detalle_montaje WHERE id_evento = ?', [id], () => {
      if (observaciones && observaciones.trim() !== '') {
        db.query('INSERT INTO detalle_montaje (id_evento, descripcion) VALUES (?, ?)', [id, observaciones], () => { });
      }
    });
    
    res.json({ mensaje: 'Evento actualizado correctamente' });
    if(reqUserId) registrarMovimiento(reqUserId, null, 'EDICION_EVENTO', `Evento ${id} actualizado.`);
  });
});

// ── EVENTOS — OBTENER TODOS ────────────────────────────
app.get('/eventos', (req, res) => {
  const { usuario_id } = req.query;
  let sql = `SELECT
       e.id_evento, e.nombre, e.modalidad, e.fecha_inicio, e.fecha_fin,
       e.hora_inicio, e.hora_fin, e.cantidad_asistentes, e.tipo_evento,
       e.monto_poa, e.moneda, e.estado, e.fecha_creacion,
       e.id_recinto, e.id_dependencia,
       pm.estado AS estado_poa,
       u.nombre  AS solicitante,
       u.id_usuario,
       d.nombre  AS dependencia,
       r.nombre  AS recinto,
       (SELECT GROUP_CONCAT(dc.tipo SEPARATOR ', ') FROM detalle_corporativo dc WHERE dc.id_evento = e.id_evento) AS detalles_corporativos,
       (SELECT GROUP_CONCAT(a.nombre SEPARATOR ', ') FROM evento_alimento ea JOIN alimento a ON ea.id_alimento = a.id_alimento WHERE ea.id_evento = e.id_evento) AS alimentos,
       (SELECT GROUP_CONCAT(dm.descripcion SEPARATOR ' | ') FROM detalle_montaje dm WHERE dm.id_evento = e.id_evento) AS observaciones,
       IF((SELECT COUNT(*) FROM servicio_audiovisual sa WHERE sa.id_evento = e.id_evento) > 0, 1, 0) AS necesita_audiovisual,
       (SELECT GROUP_CONCAT(CONCAT(sa.cantidad, 'x ', sa.tipo_servicio) SEPARATOR ', ') FROM servicio_audiovisual sa WHERE sa.id_evento = e.id_evento AND sa.estado != 'Rechazado') AS equipos_audiovisuales
     FROM evento e
     LEFT JOIN poa_movimiento pm ON e.id_evento = pm.id_evento
     LEFT JOIN usuario     u ON e.id_usuario     = u.id_usuario
     LEFT JOIN dependencia d ON e.id_dependencia = d.id_dependencia
     LEFT JOIN recinto     r ON e.id_recinto     = r.id_recinto`;
  
  const params = [];
  if (usuario_id) {
    sql += ` WHERE e.id_usuario = ?`;
    params.push(usuario_id);
  }

  sql += ` ORDER BY e.fecha_creacion DESC`;

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// ── EVENTOS — CALENDARIO PRIVADO ───────────────────────
app.get('/calendario-eventos', (req, res) => {
  const { usuario_id } = req.query; // ID del usuario que consulta
  
  const sql = `
    SELECT 
      e.id_evento, e.nombre, e.fecha_inicio, e.fecha_fin, e.id_usuario,
      r.nombre AS recinto,
      IF((SELECT COUNT(*) FROM servicio_audiovisual sa WHERE sa.id_evento = e.id_evento AND sa.estado != 'Rechazado') > 0, 1, 0) AS necesita_audiovisual
    FROM evento e
    LEFT JOIN recinto r ON e.id_recinto = r.id_recinto
    WHERE e.estado != 'Rechazado'
  `;

  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    const processed = results.map(evt => {
      const esPropio = usuario_id && evt.id_usuario == usuario_id;
      return {
        id: evt.id_evento,
        start: evt.fecha_inicio,
        end: evt.fecha_fin,
        title: esPropio ? evt.nombre : "Ocupado",
        recinto: esPropio ? evt.recinto : "Información Privada",
        esPropio: esPropio,
        necesita_audiovisual: evt.necesita_audiovisual === 1
      };
    });

    res.json(processed);
  });
});

// ── EVENTOS — ACTUALIZAR ESTADO ────────────────────────
app.put('/eventos/:id/estado', (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  const estadosValidos = ['Pendiente', 'Aprobado', 'Rechazado', 'Finalizado'];
  if (!estadosValidos.includes(estado))
    return res.status(400).json({ mensaje: 'Estado no válido' });
  db.query('UPDATE evento SET estado=? WHERE id_evento=?', [estado, id], (err) => {
    if (err) return res.status(500).json({ mensaje: 'Error al actualizar estado', error: err.message });
    res.json({ mensaje: 'Estado actualizado con éxito' });
    const reqUserId = req.headers['x-usuario-id'];
    if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_EVENTO', `Resolución de Estado del Evento. El Evento con ID ${id} ha pasado al estado: "${estado}".`);
  });
});

// ── EVENTOS — ELIMINAR ─────────────────────────────────
app.delete('/eventos/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM detalle_corporativo WHERE id_evento=?', [id], () => {
    db.query('DELETE FROM evento_alimento WHERE id_evento=?', [id], () => {
      db.query('DELETE FROM detalle_montaje WHERE id_evento=?', [id], () => {
        db.query('DELETE FROM evento WHERE id_evento=?', [id], (err) => {
          if (err) return res.status(500).json({ mensaje: 'Error al eliminar evento', error: err.message });
          res.json({ mensaje: 'Evento eliminado con éxito' });
          const reqUserId = req.headers['x-usuario-id'];
          if(reqUserId) registrarMovimiento(reqUserId, null, 'ELIMINACION_EVENTO', `Cancelación y Borrado de Evento. Evento afectado ID: ${id}.`);
        });
      });
    });
  });
});

// ── AUDIOVISUAL — CREAR SOLICITUD ──────────────────────
app.post('/audiovisual', (req, res) => {
  const { id_evento, servicios } = req.body;
  // servicios será un array de objetos: { equipo: 'Proyector', cantidad: 2, descripcion: '...', ubicacion: '...', observaciones: '...' }

  if (!id_evento || !servicios || servicios.length === 0) {
    return res.status(400).json({ mensaje: 'Faltan datos requeridos o servicios audiovisuales.' });
  }

  // 1. Validar la regla de 5 días de anticipación
  db.query('SELECT fecha_inicio FROM evento WHERE id_evento = ?', [id_evento], (err, results) => {
    if (err) return res.status(500).json({ mensaje: 'Error al buscar el evento', error: err.message });
    if (results.length === 0) return res.status(404).json({ mensaje: 'Evento no encontrado' });

    const fechaEvento = new Date(results[0].fecha_inicio);
    const fechaActual = new Date();
    // Neutralizar horas para calcular la diferencia de días correctamente
    fechaEvento.setHours(0, 0, 0, 0);
    fechaActual.setHours(0, 0, 0, 0);

    const diferenciaTiempo = fechaEvento.getTime() - fechaActual.getTime();
    const diferenciaDias = Math.ceil(diferenciaTiempo / (1000 * 3600 * 24));

    if (diferenciaDias < 5) {
      return res.status(400).json({
        mensaje: `Políticas institucionales: La solicitud de equipos audiovisuales requiere un mínimo de 5 días de antelación. Faltan ${diferenciaDias} días para el evento.`,
        dias_restantes: diferenciaDias
      });
    }

    // 2. Insertar los servicios reales en la DB con las nuevas columnas
    const values = servicios.map(s => {
      // (id_evento, tipo_servicio, estado, cantidad, ubicacion, observaciones)
      return [
        id_evento,
        s.equipo,
        'Pendiente',
        s.cantidad || 1,
        s.ubicacion || '',
        s.observaciones || ''
      ];
    });

    db.query('INSERT INTO servicio_audiovisual (id_evento, tipo_servicio, estado, cantidad, ubicacion, observaciones) VALUES ?', [values], (errInsert) => {
      if (errInsert) return res.status(500).json({ mensaje: 'Error al registrar servicios', error: errInsert.message });
      res.status(201).json({ mensaje: 'Solicitud audiovisual registrada con éxito' });
      const reqUserId = req.headers['x-usuario-id'];
      if(reqUserId) registrarMovimiento(reqUserId, null, 'CREACION_AUDIOVISUAL', `Se levantó una Solicitud de Servicios Audiovisuales. Evento Asociado ID: ${id_evento}. Equipos requeridos: ${servicios.map(s => s.equipo).join(', ')}.`);
    });
  });
});

// ── AUDIOVISUAL — OBTENER TODAS ─────────────────────────
app.get('/audiovisual', (req, res) => {
  const { usuario_id } = req.query;
  let sql = `SELECT 
       s.id_servicio, s.id_evento, s.tipo_servicio, s.estado AS estado_av,
       s.cantidad, s.ubicacion, s.observaciones,
       e.nombre AS nombre_evento, e.fecha_inicio, r.nombre AS recinto,
       e.id_usuario, u.nombre AS nombre_usuario
     FROM servicio_audiovisual s
     JOIN evento e ON s.id_evento = e.id_evento
     LEFT JOIN recinto r ON e.id_recinto = r.id_recinto
     LEFT JOIN usuario u ON e.id_usuario = u.id_usuario`;
  
  const params = [];
  if (usuario_id) {
    sql += ` WHERE e.id_usuario = ?`;
    params.push(usuario_id);
  }

  sql += ` ORDER BY s.id_servicio DESC`;

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    const parsedResults = results.map(row => {
        // Fallback robusto en caso de que aún exista data comprimida vieja (ej: Proyector|Cant:2|Ubic:A)
        let equipo = row.tipo_servicio;
        let cant = row.cantidad;
        let ubic = row.ubicacion;
        let obs = row.observaciones;

        if (row.tipo_servicio.includes('|Cant:')) {
          const parts = row.tipo_servicio.split('|');
          equipo = parts[0];
          if (parts[1]) cant = parts[1].replace('Cant:', '');
          if (parts[2]) ubic = parts[2].replace('Ubic:', '');
          if (parts[3]) obs = parts[3].replace('Obs:', '');
        }

        return {
          id_servicio: row.id_servicio,
          id_evento: row.id_evento,
          nombre_evento: row.nombre_evento,
          fecha_evento: row.fecha_inicio,
          estado_av: row.estado_av,
          equipo: equipo,
          cantidad: cant || 1,
          ubicacion: ubic || '',
          observaciones: obs || '',
          nombre_usuario: row.nombre_usuario || ''
        };
      });

      res.json(parsedResults);
    }
  );
});

// ── AUDIOVISUAL — ACTUALIZAR ESTADO ─────────────────────
app.put('/audiovisual/:id/estado', (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  const estadosValidos = ['Pendiente', 'En revisión', 'Aprobado', 'Rechazado', 'Completado'];

  if (!estadosValidos.includes(estado))
    return res.status(400).json({ mensaje: 'Estado audiovisual no válido' });

  db.query('UPDATE servicio_audiovisual SET estado=? WHERE id_servicio=?', [estado, id], (err, result) => {
    if (err) {
      console.error('Update Error:', err);
      return res.status(500).json({ mensaje: 'Error al actualizar estado', error: err.message });
    }
    console.log(`Update Result for id ${id}:`, result);
    res.json({ mensaje: 'Estado audiovisual actualizado con éxito', affectedRows: result.affectedRows });
    const reqUserId = req.headers['x-usuario-id'];
    if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_AUDIOVISUAL', `Resolución de Solicitud Audiovisual. El ticket ID ${id} ha pasado al estado: "${estado}".`);
  });
});

// ── AUDIOVISUAL — ACTUALIZAR ESTADO (GLOBAL POR EVENTO) ─
app.put('/audiovisual/evento/:id_evento/estado', (req, res) => {
  const { id_evento } = req.params;
  const { estado } = req.body;
  const estadosValidos = ['Pendiente', 'En revisión', 'Aprobado', 'Rechazado', 'Completado'];

  if (!estadosValidos.includes(estado))
    return res.status(400).json({ mensaje: 'Estado audiovisual no válido' });

  db.query('UPDATE servicio_audiovisual SET estado=? WHERE id_evento=?', [estado, id_evento], (err, result) => {
    if (err) {
      console.error('Update All Error:', err);
      return res.status(500).json({ mensaje: 'Error al actualizar estado general', error: err.message });
    }
    res.json({ mensaje: 'Estado audiovisual del evento actualizado con éxito', affectedRows: result.affectedRows });
    const reqUserId = req.headers['x-usuario-id'];
    if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_AUDIOVISUAL_GLOBAL', `Resolución Global de Audiovisual. Los servicios del Evento ID ${id_evento} pasaron al estado: "${estado}".`);
  });
});

// ── RESTABLECIMIENTO DE CONTRASEÑA (EMAIL FLOW) ───────
app.post('/solicitar-restablecimiento', (req, res) => {
  const { correo } = req.body;

  db.query('SELECT id_usuario FROM usuario WHERE correo = ?', [correo], (err, results) => {
    if (err) return res.status(500).json({ mensaje: 'Error al consultar la base de datos' });
    if (results.length === 0) {
      return res.status(404).json({ mensaje: 'El correo no está registrado' });
    }

    // Generar token único
    const token = crypto.randomBytes(32).toString('hex');
    const expiracion = new Date(Date.now() + 3600000); // 1 hora de validez

    db.query(
      'INSERT INTO restablecimiento_token (correo, token, expiracion) VALUES (?, ?, ?)',
      [correo, token, expiracion],
      (errInsert) => {
        if (errInsert) return res.status(500).json({ mensaje: 'Error al generar el token' });

        const link = `http://localhost:3000/reset-password/${token}`;

        // Transportador Gmail
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS,
          },
        });

        const mailOptions = {
          from: `"ProEvent UAPA" <${process.env.GMAIL_USER}>`,
          to: correo,
          subject: 'Restablecer tu contraseña - ProEvent UAPA',
          text: `Hola,\n\nRecibimos una solicitud para restablecer la contraseña de tu cuenta en ProEvent UAPA.\n\nEnlace de restablecimiento (válido por 1 hora):\n${link}\n\nSi no solicitaste este cambio, ignora este correo.\n\nSistema de Gestión de Eventos – UAPA ProEvent`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px; border: 1px solid #e0e0e0; border-radius: 14px;">
              <div style="text-align:center; margin-bottom: 20px;">
                <span style="background:#1e3a5f; color:white; font-size:22px; font-weight:bold; padding:8px 18px; border-radius:8px;">PE</span>
                <span style="font-size:22px; font-weight:bold; color:#1e3a5f; margin-left:10px;">Pro<span style="color:#f97316;">Event</span></span>
              </div>
              <h2 style="color:#1e3a5f; text-align:center;">Recuperación de Contraseña</h2>
              <p>Hola,</p>
              <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el botón de abajo para continuar. <strong>Este enlace es válido por 1 hora.</strong></p>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${link}" style="background-color:#1e3a5f; color:white; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:16px; display:inline-block;">
                  Restablecer Contraseña
                </a>
              </div>
              <p style="font-size:13px; color:#555;">O copia y pega este enlace en tu navegador:</p>
              <p style="word-break:break-all; color:#1e3a5f; font-size:13px;">${link}</p>
              <hr style="border:none; border-top:1px solid #eee; margin:24px 0;">
              <p style="color:#aaa; font-size:12px;">Si no solicitaste este cambio, ignora este correo. Tu cuenta sigue segura.</p>
              <p style="color:#ccc; font-size:11px;">Sistema de Gestión de Eventos – Universidad UAPA</p>
            </div>
          `,
        };

        transporter.sendMail(mailOptions, (errMail, info) => {
          if (errMail) {
            console.error('❌ Error enviando correo:', errMail.message);
            return res.status(500).json({ mensaje: 'Error al enviar el correo. Intente de nuevo.' });
          }
          console.log(`✅ Correo enviado a: ${correo} (ID: ${info.messageId})`);
          res.json({ mensaje: 'Se ha enviado un enlace a su correo electrónico.' });
        });
      }
    );
  });
});

app.get('/validar-token/:token', (req, res) => {
  const { token } = req.params;
  db.query(
    'SELECT correo FROM restablecimiento_token WHERE token = ? AND expiracion > NOW()',
    [token],
    (err, results) => {
      if (err) return res.status(500).json({ mensaje: 'Error al validar el token' });
      if (results.length === 0) {
        return res.status(400).json({ mensaje: 'Token inválido o expirado' });
      }
      res.json({ mensaje: 'Token válido', correo: results[0].correo });
    }
  );
});

app.post('/restablecer-contrasena', (req, res) => {
  const { token, nuevaContrasena } = req.body;

  // 1. Validar token
  db.query(
    'SELECT correo FROM restablecimiento_token WHERE token = ? AND expiracion > NOW()',
    [token],
    (err, results) => {
      if (err) return res.status(500).json({ mensaje: 'Error al validar el token' });
      if (results.length === 0) {
        return res.status(400).json({ mensaje: 'Token inválido o expirado' });
      }

      const correo = results[0].correo;

      // 2. Actualizar contraseña
      db.query(
        'UPDATE usuario SET contrasena = ? WHERE correo = ?',
        [nuevaContrasena, correo],
        (errUpdate) => {
          if (errUpdate) return res.status(500).json({ mensaje: 'Error al actualizar la contraseña' });

          // 3. Eliminar token usado
          db.query('DELETE FROM restablecimiento_token WHERE correo = ?', [correo], () => { });

          res.json({ mensaje: 'Contraseña actualizada con éxito' });
        }
      );
    }
  );
});

// ── EVALUACIONES — CREAR ───────────────────────────────
app.post('/evaluaciones', (req, res) => {
  const { id_evento, respuesta_solicitud, recinto, valoracion_respuesta, satisfaccion, comentario } = req.body;

  if (!id_evento || !respuesta_solicitud || !recinto || !valoracion_respuesta || !satisfaccion) {
    return res.status(400).json({ mensaje: 'Todos los campos obligatorios deben ser completados.' });
  }

  if (satisfaccion < 1 || satisfaccion > 5) {
    return res.status(400).json({ mensaje: 'El nivel de satisfacción debe estar entre 1 y 5.' });
  }

  db.query(
    `INSERT INTO evaluacion (id_evento, respuesta_solicitud, recinto, valoracion_respuesta, satisfaccion, comentario)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id_evento, respuesta_solicitud, recinto, valoracion_respuesta, satisfaccion, comentario || null],
    (err, result) => {
      if (err) return res.status(500).json({ mensaje: 'Error al registrar la evaluación', error: err.message });
      res.status(201).json({ mensaje: 'Evaluación enviada con éxito', id_evaluacion: result.insertId });
      const reqUserId = req.headers['x-usuario-id'];
      if (reqUserId) registrarMovimiento(
        reqUserId, null, 'CREACION_EVALUACION',
        `Nueva evaluación registrada. ID: ${result.insertId}. Evento ID: ${id_evento}. Recinto: ${recinto}. Valoración: ${valoracion_respuesta}. Satisfacción: ${satisfaccion}/5.`
      );
    }
  );
});

// ── EVALUACIONES — OBTENER TODAS ───────────────────────
app.get('/evaluaciones', (req, res) => {
  db.query(
    `SELECT
       ev.id_evaluacion, ev.id_evento, ev.respuesta_solicitud,
       ev.recinto, ev.valoracion_respuesta, ev.satisfaccion,
       ev.comentario, ev.fecha,
       e.nombre AS nombre_evento
     FROM evaluacion ev
     LEFT JOIN evento e ON ev.id_evento = e.id_evento
     ORDER BY ev.fecha DESC`,
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results);
    }
  );
});

// ── CATÁLOGOS DINÁMICOS ─────────────────────────────────

// 1. Equipos Audiovisuales
app.get('/equipos-audiovisuales', (req, res) => {
  db.query('SELECT * FROM equipo_audiovisual ORDER BY nombre ASC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});
app.post('/equipos-audiovisuales', (req, res) => {
  const { nombre, icono, cantidad_total } = req.body;
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' });
  db.query('INSERT INTO equipo_audiovisual (nombre, icono, cantidad_total) VALUES (?, ?, ?)', [nombre, icono || 'FiMonitor', cantidad_total || 0], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ mensaje: 'Equipo Creado', id: result.insertId });
  });
});
app.put('/equipos-audiovisuales/:id', (req, res) => {
  const { nombre, icono, cantidad_total } = req.body;
  db.query('UPDATE equipo_audiovisual SET nombre=?, icono=?, cantidad_total=? WHERE id_equipo=?', [nombre, icono, cantidad_total || 0, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Equipo Actualizado' });
  });
});
app.delete('/equipos-audiovisuales/:id', (req, res) => {
  db.query('DELETE FROM equipo_audiovisual WHERE id_equipo=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Equipo Eliminado' });
  });
});

// 2. Tipos de Evento Master
app.get('/tipos-evento', (req, res) => {
  db.query('SELECT * FROM tipo_evento_master ORDER BY nombre ASC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});
app.post('/tipos-evento', (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' });
  db.query('INSERT INTO tipo_evento_master (nombre) VALUES (?)', [nombre], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ mensaje: 'Tipo Creado', id: result.insertId });
  });
});
app.put('/tipos-evento/:id', (req, res) => {
  db.query('UPDATE tipo_evento_master SET nombre=? WHERE id_tipo_evento=?', [req.body.nombre, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Tipo Actualizado' });
  });
});
app.delete('/tipos-evento/:id', (req, res) => {
  db.query('DELETE FROM tipo_evento_master WHERE id_tipo_evento=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Tipo Eliminado' });
  });
});

// 3. Tipos de Detalle Corporativo
app.get('/tipos-detalle-corporativo', (req, res) => {
  db.query('SELECT * FROM tipo_detalle_corporativo ORDER BY nombre ASC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});
app.post('/tipos-detalle-corporativo', (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' });
  db.query('INSERT INTO tipo_detalle_corporativo (nombre) VALUES (?)', [nombre], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ mensaje: 'Detalle Creado', id: result.insertId });
  });
});
app.put('/tipos-detalle-corporativo/:id', (req, res) => {
  db.query('UPDATE tipo_detalle_corporativo SET nombre=? WHERE id_detalle_corp=?', [req.body.nombre, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Detalle Actualizado' });
  });
});
app.delete('/tipos-detalle-corporativo/:id', (req, res) => {
  db.query('DELETE FROM tipo_detalle_corporativo WHERE id_detalle_corp=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Detalle Eliminado' });
  });
});

// 4. Alimentos
app.get('/alimentos', (req, res) => {
  db.query('SELECT * FROM alimento ORDER BY nombre ASC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});
app.post('/alimentos', (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' });
  db.query('INSERT INTO alimento (nombre) VALUES (?)', [nombre], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ mensaje: 'Alimento Creado', id: result.insertId });
  });
});
app.put('/alimentos/:id', (req, res) => {
  db.query('UPDATE alimento SET nombre=? WHERE id_alimento=?', [req.body.nombre, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Alimento Actualizado' });
  });
});
app.delete('/alimentos/:id', (req, res) => {
  db.query('DELETE FROM alimento WHERE id_alimento=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Alimento Eliminado' });
  });
});

app.listen(8080, () => {
  console.log('🚀 Servidor corriendo en http://localhost:8080');
});