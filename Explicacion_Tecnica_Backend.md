# Explicación Técnica y Código del Backend (ProEvent)

A continuación, presento un desglose técnico profundo utilizando fragmentos reales del código fuente que soporta tu aplicación (extraídos de `server.js`).

---

## 1. Inicialización y Conexión a la Base de Datos (Pool)

En lugar de crear una conexión tradicional que se abre y cierra por cada solicitud, Node.js y `mysql2` se utilizan para instanciar un **Pool de Conexiones**. 

```javascript
// Importación de librerías esenciales
const express = require('express'); 
const mysql = require('mysql2'); 
require('dotenv').config();

// Configuración del Pool de Conexiones
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '', // Sin contraseña (local XAMPP)
  database: 'uapa_proevent',
  port: 3307,
  waitForConnections: true, // Pone en cola a los usuarios si el servidor se llena
  connectionLimit: 10,      // Evita sobrecargar la memoria RAM de MySQL
  queueLimit: 0
});

// Prueba en caliente de que la base funciona al encender
db.getConnection((err, connection) => {
  if (err) console.log('Error conectando a MySQL:', err);
  else {
    if (connection) connection.release(); // Libera la conexión para el uso del público
    console.log('✅ Conectado a MySQL correctamente (Pool)');
  }
});
```
**¿Cómo funciona?** Al arrancar el servidor `node server.js`, carga estas líneas. Crea 10 "hilos" o túneles hacia MySQL. Cuando miles de peticiones llegan, Express recicla estos 10 túneles inteligentemente.

---

## 2. Un Endpoint REST Básico (Lectura / Consultas)

Aquí se expone cómo la aplicación responde a una petición HTTP GET cuando el navegador requiere datos para una tabla (Ej: Listar los Usuarios e incluir el nombre de su Rol).

```javascript
// app.get expone la ruta "/usuarios"
app.get('/usuarios', (req, res) => { 
  
  // 1. Sentencia SQL pura: Cruza dos tablas (usuario y rol) usando JOIN
  const sql = `
     SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
     FROM usuario u
     JOIN rol r ON u.id_rol = r.id_rol
  `;

  // 2. Ejecuta la sentencia albergada en "db"
  db.query(sql, (err, results) => {
      // 3. Manejo de Errores
      if (err) return res.status(500).json({ error: err }); 
      
      // 4. Transformación JSON: Lo envía inmediatamente a la interfaz (React)
      res.json(results); 
    }
  );
});
```
**Análisis:**
La variable `req` trae lo que el usuario pide, y `res` (response) es el objeto que usamos para despacharle algo (`res.json()`). En este caso, procesamos un JOIN en base de datos para darle al frontal un paquete de texto limpio.

---

## 3. Seguridad Perimetral: Bloqueo de Inyección SQL y Endpoints POST

Cuando recibimos datos del Exterior (como un intento de inicio de sesión), tenemos que tratarlos con absoluta sospecha. Mira este extracto de cómo se defienden las cajas de texto contra *Hackers (SQL Injection).*

```javascript
// Método POST porque el usuario "Envía" credenciales ocultas
app.post('/login', (req, res) => { 
  
  // Extrae y descompone el cuerpo de la petición (JSON entrante)
  const { correo, contrasena } = req.body; 

  // OBSERVACIÓN TÉCNICA CLAVE: El uso de los signos de interrogación (?)
  const query = `
     SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
     FROM usuario u
     JOIN rol r ON u.id_rol = r.id_rol
     WHERE u.correo = ? AND u.contrasena = ?
  `;

  // El arreglo [correo, contrasena] se inyecta de forma sanitizada
  db.query(query, [correo, contrasena], (err, results) => {
      if (err) return res.status(500).json({ mensaje: 'Error del servidor' }); 
      
      if (results.length === 0) { 
        // HTTP 401 = Acceso No Autorizado
        return res.status(401).json({ mensaje: 'Correo o contraseña incorrectos' }); 
      }
      
      // Rescata la primera fila del resultado en la B.D
      const usuarioData = results[0]; 
      
      // Responde HTTP 200 y adjunta la información segura para que React lo deje entrar
      res.json({ mensaje: 'Login exitoso', usuario: usuarioData }); 
    }
  );
});
```
**¿Por qué las  `?` ?** Si un pirata informático escribe `1=1; DROP TABLE evento` en la casilla del correo en React, los signos `?` (Placeholders de MySQL2) lo transforman en texto literal plano antes de mezclarlo con tu base de datos central. El ataque fracasa silenciosamente.

---

## 4. Trazabilidad Universal (Registro de Control Físico)

Una vez que algo grave o importante ocurre, usamos una función programada **(Helper)** que intercepta la petición  y registra todo metódicamente en nuestro sistema subyacente de "Bitácoras" de auditorios.

```javascript
// Función global auxiliar ("Helper")
function registrarMovimiento(id_usuario, id_rol, accion, detalles = '') {
  if (!id_usuario) return; // Si no hay usuario ejecutor, ignora.

  const sql = 'INSERT INTO bitacora_movimiento (id_usuario, id_rol, accion, detalles) VALUES (?, ?, ?, ?)';
  
  // Ejecuta de forma asíncrona ("Sin pausar" al usuario) la escritura
  db.query(sql, [id_usuario, id_rol, accion, detalles], (err) => {
    if (err) console.error('Error registrando bitácora:', err); 
  });
}
```
*Se llama de manera invisible al final de las rutas cruciales, por ejemplo, cuando un Administrador Borra un registro en el Endpoint de ELIMINAR:*

```javascript
app.delete('/usuarios/:id', (req, res) => { 
  const { id } = req.params; // Extrae el parámetro de la URL (ej: /usuarios/45)
  // ...lógica de borrado aquí...
  
  // Registro Categórico en Bitácora identificando quién presionó el botón (usando headers)
  const adminId = req.headers['x-usuario-id'];
  registrarMovimiento(adminId, null, 'ELIMINACION_USUARIO', `Se eliminó para siempre la cuenta con ID: ${id}.`);
});
```

---

## 5. Automatización Computacional (Cron Jobs)

No siempre el backend espera a que el humano haga "Click". El backend de ProEvent es capaz de tomar determinaciones por sí solo gracias a la función `setInterval` de NodeJS. Se encarga de barrer diariamente los eventos y Finalizarlos matemáticamente.

```javascript
// Lógica encapsulada en una función de barrido
function autoFinalizarEventos() {
  const hoy = new Date().toISOString().slice(0, 10); // Ejemplo: '2026-03-30'

  // Busca los IDs de eventos donde la fecha límite YA PASÓ
  const sqlSelect = "SELECT id_evento FROM evento WHERE estado = 'Aprobado' AND DATE(fecha_fin) < ?";
  
  db.query(sqlSelect, [hoy], (err, eventos) => {
    if (eventos.length === 0) return; // Si no hay nada caducado, se apaga silenciosamente

    const ids = eventos.map(e => e.id_evento); 

    // Hace una Actualización Masiva (Bulk Update) en un milisegundo a todos esos IDs
    db.query(`UPDATE evento SET estado = 'Finalizado' WHERE id_evento IN (?)`, [ids], () => {
        console.log(`✅ Auto-finalizados ${eventos.length} macroeventos.`);
    });
  });
}

// Disparador de Tiempo: 
setInterval(autoFinalizarEventos, 60 * 60 * 1000); 
// Se ejecuta de manera cíclica cada 3,600,000 milisegundos (1 Hora) independientemente de si hay usuarios en el sistema o no.
```
