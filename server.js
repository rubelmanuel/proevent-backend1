// --- IMPORTACIONES PRINCIPALES ---
const express = require('express'); // Framework web minimalista para crear el servidor HTTP en Node.js
const mysql = require('mysql2'); // Driver para establecer y manejar conexiones con la base de datos MySQL
const cors = require('cors'); // Middleware que habilita CORS permitiendo que el Frontend (React) haga peticiones al Backend
const crypto = require('crypto'); // Módulo de criptografía nativo de Node (usado para generar tokens de contraseña)
const nodemailer = require('nodemailer'); // Librería estándar para el transporte y envío de correos electrónicos
const { OAuth2Client } = require('google-auth-library'); // SDK de Google para verificar tokens de sesión OAuth2
require('dotenv').config(); // Carga las variables de entorno almacenadas en el archivo .env al objeto process.env

// --- CONFIGURACIÓN DE GOOGLE OAUTH ---
const GOOGLE_CLIENT_ID = '426335318098-v39ood0lcapc22lgoq3lons62hbf507m.apps.googleusercontent.com'; // Credencial pública de la App en Google Cloud
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID); // Inicializa el cliente oficial de Google para validar inicio de sesión

// --- CONFIGURACIÓN DEL SERVIDOR EXPRESS ---
const app = express(); // Instancia un nuevo servidor Express
app.use(cors()); // Se añade el middleware global CORS a todas las rutas
app.use(express.json()); // Middleware global que parsea cualquier body JSON recibido en las peticiones entrantes

// --- CONFIGURACIÓN DE LA BASE DE DATOS MÚLTIPLES-CONEXIONES (POOL) ---
const db = mysql.createPool({ // El Pool mantiene las conexiones vivas y las reutiliza en lugar de crear nuevas cada vez
  host: 'localhost', // Dirección local de la base de datos
  user: 'root', // Usuario por defecto de instalación XAMPP/MySQL
  password: '', // Sin contraseña (por defecto de fábrica en instaladores locales)
  database: 'uapa_proevent', // El esquema lógico objetivo que debe existir en MySQL
  port: 3307, // Puerto específico diferente al 3306 por defecto, configurado localmente
  waitForConnections: true, // Si todas las conexiones están en uso, las siguientes esperan libres en lugar de fallar
  connectionLimit: 10, // Define el número máximo de conexiones para no saturar la base de datos
  queueLimit: 0 // Sin límite en la cola de peticiones en espera (0 = infinito)
});

// Prueba de la conexión inicial extrayendo un worker del pool de MySQL
db.getConnection((err, connection) => {
  if (err) { // Evalúa si ocurrió una falla en la conexión inicial
    console.log('Error conectando a MySQL:', err); // Muestra el mensaje de error por consola
    return; // Cancela la continuación del flujo actual
  }
  if (connection) connection.release(); // Libera la conexión devolviéndola al pool tras confirmar que sí funciona
  console.log('✅ Conectado a MySQL correctamente (Pool)'); // Notifica estado saludable por consola web/terminal

  // --- INICIALIZACIONES ESTRUCTURALES AUTOMÁTICAS ---
  // Script DDL de SQL para garantizar en caliente que la tabla de recuperación de clave existe siempre
  const createTokensTable = `
    CREATE TABLE IF NOT EXISTS restablecimiento_token ( -- Crea tabla solo si el esquema no la contiene
      id_token INT AUTO_INCREMENT PRIMARY KEY, -- Clave primaria que se numera sola por registro
      correo VARCHAR(120) NOT NULL, -- Columna string obligatoria para asociar el email al token
      token VARCHAR(255) NOT NULL, -- Columna string para guardar el hash encriptado
      expiracion DATETIME NOT NULL -- Marca de tiempo estricta para caducar el pin/token de seguridad
    )
  `;
  // Interacción directa para ejecutar la creación preventiva de la tabla temporal de tokens
  db.query(createTokensTable, (err) => {
    if (err) console.error('Error al crear la tabla de tokens:', err); // Reporta fallo DDL si el usuario MySQL carece de permisos
    else console.log('✅ Tabla de tokens verificada/creada'); // Mensaje positivo validando que la tabla es funcional
  });

  // --- INICIALIZACIÓN DE TABLA DE EVALUACIONES ---
  // Define la estructura SQL necesaria para almacenar las evaluaciones de satisfacción post-evento
  const createEvalTable = `
    CREATE TABLE IF NOT EXISTS evaluacion ( -- Solo crea la tabla si ésta no existe en la BD
      id_evaluacion INT AUTO_INCREMENT PRIMARY KEY, -- ID autoincremental para cada evaluación única
      id_evento INT NOT NULL, -- Clave foránea que vincula la evaluación con un evento específico
      respuesta_solicitud ENUM('Si','No'), -- Opción binaria sobre la agilidad de la respuesta
      recinto ENUM('Cibao Oriental','Nagua','Santo Domingo Oriental','Santiago'), -- Ubicación física donde ocurrió el evento
      valoracion_respuesta ENUM('Muy eficiente','Excelente','Eficiente','Deficiente'), -- Escala cualitativa del servicio
      satisfaccion INT CHECK (satisfaccion BETWEEN 1 AND 5), -- Escala cuantitativa validada entre 1 y 5 estrellas
      comentario TEXT, -- Campo de texto libre para observaciones adicionales del solicitante
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP, -- Registra automáticamente el momento exacto en que se creó la evaluación
      FOREIGN KEY (id_evento) REFERENCES evento(id_evento) ON DELETE CASCADE -- Borra las evaluaciones si se borra el evento asociado (Integridad referencial estricta)
    )
  `;
  // Ejecuta la consulta de inicialización para la tabla de evaluación
  db.query(createEvalTable, (err) => {
    if (err) console.error('Error al crear la tabla de evaluaciones:', err); // Alerta en la consola de Node si falla el acceso o permisos
    else console.log('✅ Tabla de evaluaciones verificada/creada'); // Confirma por terminal que todo está en orden con el esquema
  });
});

// --- FUNCIONES DE APOYO (HELPERS) ---
// Función reutilizable (Helper): Registra una acción administrativa o del sistema en la base de datos auditable (Bitácora)
function registrarMovimiento(id_usuario, id_rol, accion, detalles = '') {
  if (!id_usuario) return; // Validación de seguridad: no puede registrarse nada sin un responsable directo asociado (id_usuario)
  
  // Sub-función interna (Closure) que realiza la inserción física real en la base de datos
  const registrar = (id_usr, id_rl) => {
    // Sentencia SQL insertando el log de forma parametrizada explícita (usando signaturas '?' para prevenir ataques de inyección SQL)
    const sql = 'INSERT INTO bitacora_movimiento (id_usuario, id_rol, accion, detalles) VALUES (?, ?, ?, ?)';
    db.query(sql, [id_usr, id_rl, accion, detalles], (err) => {
      // Manejo silencioso de errores para garantizar que si falla la bitácora, NO derribe la petición en curso del usuario
      if (err) console.error('Error registrando bitácora:', err); 
    });
  };

  if (!id_rol) { // Si la función padre fue llamada sin proveer un ID de rol, el sistema asume hacer una consulta extra para encontrarlo
    db.query('SELECT id_rol FROM usuario WHERE id_usuario = ?', [id_usuario], (err, res) => {
      if (!err && res.length > 0) registrar(id_usuario, res[0].id_rol); // Una vez obtenido de la base de datos, ejecuta el insert interno asincrónico
    });
  } else {
    registrar(id_usuario, id_rol); // Si la información requerida ya estaba provista plenamente, la registra de manera inmediata y sincrónica
  }
}

// --- PROCESOS EN SEGUNDO PLANO (CRON JOBS SIMULADOS) ---
// ── AUTO-FINALIZACIÓN DE EVENTOS ─────────────────────────
// Tarea automática: Revisa iterativamente si algún evento catalogado actualmente como 'Aprobado'
// ya dejó atrás su fecha límite esperada (fecha_fin) en el mundo real y lo auto-marca en tabla como 'Finalizado'.
function autoFinalizarEventos() {
  const hoy = new Date().toISOString().slice(0, 10); // Genera la cadena de texto de la fecha actual en formato ISO estricto 'YYYY-MM-DD' para comparar con MySQL

  // Consulta parametrizada para obtener los ID de todos los eventos aprobados donde la fecha de finalización cronológica general sea inferior a la de la medianoche pasada (eventos vencidos)
  const sql = `
    SELECT id_evento, nombre, id_usuario
    FROM evento
    WHERE estado = 'Aprobado'
      AND DATE(fecha_fin) < ? -- Filtro restrictivo condicional evaluando si ya transcurrió en el calendario la fecha límite
  `;

  // Ejecución asíncrona de la consulta de letura hacia BD conectada
  db.query(sql, [hoy], (err, eventos) => {
    if (err) { // Captura si existió error de sintaxis web u error del servidor MySQL local
      console.error('❌ Error en auto-finalización:', err.message); // Notifica el fallo del Job iterativo en la terminal viva del administrador
      return; // Cesa y aborta la sub-ejecución anticipadamente de la función cron
    }
    if (eventos.length === 0) return; // Validación de control de flujos: Si no encontró absolutamente ningún evento caducado en la búsqueda, finaliza el script limpiamente en ese momento.

    const ids = eventos.map(e => e.id_evento); // Transforma en loop natural a Array los objetos y extrae únicamente todos los referenciales id_evento a la vista en un arreglo simple y plano ([1, 4, 6...])
    // Ejecuta consecuentemente una actualización en masa (Bulk Operation en SQL) directamente sobre esos identificadores numéricos capturados
    db.query(
      `UPDATE evento SET estado = 'Finalizado' WHERE id_evento IN (?)`, // Reemplazamiento escalonado masivamente ordenado en un único hilo
      [ids], // Acopla como variable ligada a la query todo el arreglo de identificantes en fila in(?) de sentencias directas
      (errUpd) => {
        if (errUpd) { // Manejador de catch de fallo secundario específico para el intentador Update masivo
          console.error('❌ Error al finalizar eventos:', errUpd.message);
          return; // Destruye ciclo del updater si este fracasa
        }
        console.log(`✅ Auto-finalizados ${eventos.length} evento(s): IDs [${ids.join(', ')}]`); // Imprime satisfactoriamente registro de operación modificadora documentando tamaño impactado en consola
        
        // Ciclo secuencial interactivo para documentar uno por uno los históricos operados en la base 
        eventos.forEach(e => {
          if (e.id_usuario) { // Garantiza seguridad asegurando que genuinamente existió en el row el ID del originado humano
            registrarMovimiento(
              e.id_usuario, // Culpabilidad técnica virtual auto-asignable como creador del originante inicial
              null, // Rol es null forzando auto-resolver el callback helper db para leer su row 
              'AUTO_FINALIZACION_EVENTO', // Bandera unívoca clave sobre operación computacional sistemática programada
              `El evento "${e.nombre}" (ID: ${e.id_evento}) fue finalizado automáticamente al superar su fecha de fin.` // Relato traducido plenamente legible a usuario corriente en la tabla visual de las bitácoras
            );
          }
        });
      }
    );
  });
}

// Interacción para levantar servicios cron
autoFinalizarEventos(); // Efectúa una auto-revisión instintivamente una sola vez de inmediato en el preciso microsegundo donde se habilita en RAM el servidor backend Node
setInterval(autoFinalizarEventos, 60 * 60 * 1000); // Dispara sub-rutina permanente a repetirse circular iterativamente eternamente con un plazo intermedio de 1 hora o 3600 segundos calculados matemáticamente


// --- RUTAS DE AUTENTICACIÓN ---
// INICIO DE SESIÓN TRADICIONAL (Email y Contraseña)
app.post('/login', (req, res) => { // Define el endpoint HTTP POST para procesar credenciales nativas bajo la ruta '/login'
  const { correo, contrasena } = req.body; // Extrae descriptivamente (Desestructuración) los campos 'correo' y 'contrasena' del cuerpo JSON enviado por el cliente
  // Prepara la consulta para buscar en la base de datos si existe el usuario con ambos campos coincidentes
  db.query(
    `SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
     FROM usuario u
     JOIN rol r ON u.id_rol = r.id_rol
     WHERE u.correo = ? AND u.contrasena = ?`, // Filtra los resultados usando placeholders seguros '(?)'
    [correo, contrasena], // Inyecta las variables limpias de usuario a la validación de base de datos
    (err, results) => { // Función flecha de callback (Callback) de llamada tras la ejecución MySQL
      if (err) return res.status(500).json({ mensaje: 'Error del servidor' }); // Retorna fallo HTTP 500 si la base de datos arrojó una excepción técnica 
      if (results.length === 0) { // Si el Array de resultados viene vacío significa que las credenciales no hacen "Match" (No existe el par correo/clave)
        return res.status(401).json({ mensaje: 'Correo o contraseña incorrectos' }); // Emite explícitamente Rechazo de Autorización (HTTP 401 Unauthorized)
      }
      const usuarioData = results[0]; // Extrae el primer (y esperado único) registro validado desde la matriz del query
      res.json({ mensaje: 'Login exitoso', usuario: usuarioData }); // Entrega alegremente el payload (Datos permitidos) al framework frontend
      // Ejecuta asincrónicamente el guardado del incidente al libro de auditorías (Bitácora)
      registrarMovimiento(usuarioData.id_usuario, usuarioData.id_rol, 'LOGIN', `Sesión Inicada (Manual). Autenticado como ${usuarioData.nombre} (${correo}) bajo el rol de ${usuarioData.rol}.`);
    }
  );
});

// INICIO DE SESIÓN CON GOOGLE OAUTH2
app.post('/login-google', async (req, res) => { // Endpoint POST independiente destinado al servicio Third-Party Login ('/login-google')
  const { credential } = req.body; // Extrae el token encriptado que emitió directamente el componente de Google en el frontal
  if (!credential) { // Evalúa de forma estricta que el intento no sea una petición defectuosa sin credencial lógica
    return res.status(400).json({ mensaje: 'Falta el token de Google' }); // Responde con Error HTTP 400 (Bad Request)
  }

  try { // Apertura de bloque Try-Catch global para gobernar las promesas asíncronas vulnerables a fallos lógicos
    // Envía la firma codificada hacia las bóvedas de Google remotamente para certificar criptográficamente que el token sí lo fabricaron ellos y a nombre de esta App local
    const ticket = await googleClient.verifyIdToken({
      idToken: credential, // Inserta la credencial pública recuperada del front
      audience: GOOGLE_CLIENT_ID, // Compara verificando la huella originaria coincidente (Client ID oficial configurado en líneas iniciales)
    });
    const payload = ticket.getPayload(); // Desempaqueta y desencripta localmente la carga útil original enviada por los servidores robustos de Google con los datos de sesión garantizados
    const correo = payload.email; // Rescata el correo verficado absoluto  (Propiedad 'email')

    // Ahora, realiza un chequeo intrínseco preguntando si este correo verificado externo existe empadronado positivamente dentro del software local
    db.query(
      `SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
       FROM usuario u
       JOIN rol r ON u.id_rol = r.id_rol
       WHERE u.correo = ?`, // Busca estrictamente en columnario por correo ignorando contraseñas tradicionales
      [correo], // Sustituye con el email validado internacionalmente en la red
      (err, results) => {
        if (err) return res.status(500).json({ mensaje: 'Error del servidor' }); // Captura fallos directos a nivel de infraestructura de base de datos
        if (results.length === 0) { // Si el Array evaluado está hueco, asume tajantemente que el Google Account es válido pero no pertenece ni ha sido creado empleado de la institución local preexistente
          // Si el correo genuino devuelto por Google no existe explícitamente en la base de datos MySQL local actual
          return res.status(403).json({ mensaje: 'Correo no registrado en el sistema. Contacte al administrador.' }); // Deniega sistemáticamente el cruce de paso formalmente con Forbidden (HTTP status 403)
        }
        // Éxito comprobado, el correo está registrado y habilitado funcionalmente
        const usuarioData = results[0]; // Captura y aparta en variable literal pura el paquete local del dependiente institucional
        res.json({ mensaje: 'Login exitoso', usuario: usuarioData }); // Permite entrada pasiva y le dispensa paralelamente su información de acceso interior en estructura JSON al app cliente reactivo
        // Emplaza y archiva operativamente este acceso exterior exitoso de manera singular en el reporte histórico imborrable del sistema corporativo (Bitácora) 
        registrarMovimiento(usuarioData.id_usuario, usuarioData.id_rol, 'LOGIN_GOOGLE', `Sesión Inicada (Google OAuth). Autenticado como ${usuarioData.nombre} (${correo}) bajo el rol de ${usuarioData.rol}.`);
      }
    );
  } catch (error) { // Atrapa las crisis asíncronas impredecibles o exepciones latentes provenientes de la verificación foránea Google en verifyIdToken() global
    console.error('Error verificando token de Google:', error); // Anuncia obligatoriamente la severidad técnica real ocurrida en el background interno consola Nodejs
    res.status(401).json({ mensaje: 'Token de Google inválido' }); // Emite y fináliza oficialmente devolviendo el evento de veto directo por Token corrompido, falso o flagrantemente vencido
  }
});

// --- RUTAS DE LECTURA GET (MÓDULO DE ADMINISTRACIÓN) ---
// OBTENER la lista completa de TODOS LOS USUARIOS adjuntando su denominación de Rol (Join)
app.get('/usuarios', (req, res) => { // Establece ruta HTTP GET universal en '/usuarios' para listados generales
  db.query( // Dispara y procesa sentencia MySQL a ejecutar 
    `SELECT u.id_usuario, u.nombre, u.correo, r.nombre AS rol
     FROM usuario u
     JOIN rol r ON u.id_rol = r.id_rol`, // Une las dos entidades tabulares para traer el texto legible humano del "Rol" y no solo el ID numérico frío indexado
    (err, results) => { // Función anonima Callback
      if (err) return res.status(500).json({ error: err }); // Redirige en vivo un error técnico o fallo persistente como respuesta interceptable terminal Server-error
      res.json(results); // Analiza, formatea, e hidrata masivamente en texto el conjunto compilado entregado en JSON Array para presentarlo al framework client
    }
  );
});

// OBTENER TODOS LOS HISTORIALES DE ACTIVIDAD CONTINUA (Vista principal de bitácora referenciando movimientos y huellas completas unificadas)
app.get('/bitacora', (req, res) => { // Construye y expone la ruta vital GET '/bitacora'
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
    LEFT JOIN usuario u ON b.id_usuario = u.id_usuario -- Se anexa el usuario atenuadamente y cruzando de forma holandesa parcial/izquierda para que estructuralmente no desaparezca la iteración original si un usuario gestor eventualmente fue permanentemente borrado del disco (Left Join DB Strategy)
    LEFT JOIN rol r ON b.id_rol = r.id_rol -- Lo mismo ocurre conceptualmente idéntico abogando la existencia perenne o nula temporal con el Rol referenciado
    ORDER BY b.fecha DESC; -- Ordena visualmente y operativamente siempre mostrando los eventos de actividad más frescos y transaccionales temporalmente recientes priorizados en la cima alta
  `;
  db.query(query, (err, results) => { // Efectúa internamente la lectura pasiva profunda del hilo MySQL
    if (err) return res.status(500).json({ error: err }); // Delegación estándar de abort failure handling
    res.json(results); // Encapsula y envía la respuesta global cruda generada por todos los registros clasificados en cascada tipo JSON Object Array al cliente virtual UI Frontend
  });
});

// OBTENER el compendio inmutable de ROLES estáticos disponibles listos para ser usados en el engranaje del sistema (Normalmente selectores Select/Combobox Modales)
app.get('/roles', (req, res) => { // Asignación de Ruta simple universal '/roles'
  db.query('SELECT * FROM rol', (err, results) => { // Trae forzadamente el íntegro universal existente desglosado localmente de la tabla incondicional 'rol'
    if (err) return res.status(500).json({ error: err }); // Retorno inminente fatal si explícitamente falla todo el fetch backend
    res.json(results); // Emisión simple nativa directa de un conjunto inactivo generalizado con opciones únicas de roles paramétricos integrales
  });
});

// --- RUTAS DE ESCRITURA Y MUTACIÓN ACTIVA (CRUD USUARIOS) ---
// CREAR UN NUEVO USUARIO EN PANEL ADMINISTRATIVO (Método POST de inyección)
app.post('/usuarios', (req, res) => { // Asigna protocolo procedimental POST apuntado explícitamente a '/usuarios'
  const { nombre, correo, contrasena, id_rol } = req.body; // Cosecha las especificaciones emitidas por el frontend a raíz del formulario modal orgánico rellenado
  if (!nombre || !correo || !contrasena || !id_rol) { // Mecanismo encriptado de control interno validacional previo estructural para proteger la BD de peticiones erróneamente vacías o de origen nulo dudoso (Filtro Anti-Nulls)
    return res.status(400).json({ mensaje: 'Todos los campos son obligatorios' }); // Rechaza procedencia terminantemente ante la imperativa escasez detectada de alguno de los 4 pilares informativos primordiales
  }
  db.query( // Realiza transaccionalmente un intento forzado de insercion relacional MySQL blindado asimétricamente con prepare-statement posicional ("?") para contrarrestar ataques cibernéticos elementales
    'INSERT INTO usuario (nombre, correo, contrasena, id_rol) VALUES (?, ?, ?, ?)', 
    [nombre, correo, contrasena, id_rol], // Despliega e imbrica iterativamente la matriz natural emparejada correspondientemente a los placeholders huecos variables de la sentencia final en cadena generada
    (err, result) => {
      if (err) { // Manejador condicional iterativo estricto ramificado en base a la respuesta literal del servidor MySQL
        if (err.code === 'ER_DUP_ENTRY') { // Constata y sub-analiza comparativamente de manera explícita interna si el gestor MySQL flagrantemente detectó rebotando que el índice físico fue violado en pura duplicidad prohibitiva (UNIQUE KEY interpuesta artificialmente en correo)
          return res.status(409).json({ mensaje: 'El correo ya está registrado' }); // Traduce diplomáticamente el tecnicismo de backend a una respuesta cliente frontend 100% amigable y legible etiquetada con código de bloqueo '409 Conflict'
        }
        return res.status(500).json({ mensaje: 'Error al crear usuario', error: err }); // Redundancia y Falla genérica genérica absoluta no relacionada en esencia a factores obvios controlables (duplicados lógicos u ausencias de rellenado)
      }
      res.status(201).json({ mensaje: 'Usuario creado con éxito', id: result.insertId }); // Manifiesta veredicta positivamente Éxito absoluto final emitiendo estatus de entidad forjada HTTP 201 (Created), transmitiéndole correlativamente el nuevo numérico nominal de llave primaria autogenerada MySQL finalizada satisfactoriamente (insertId referenciado)
      
      const adminId = req.headers['x-usuario-id']; // Lee proactivamente el metadato encajado Header silencioso adicional de la petición inyectada enviado para averiguar y destripar inteligentemente de facto a quién (A qué UUID específico administrador) someter forzosamente a responsiva e identificar auditablemente
      if(adminId) registrarMovimiento(adminId, null, 'CREACION_USUARIO', `Registro de nuevo usuario. ID asignado: ${result.insertId}, Nombre: ${nombre}, Correo: ${correo}, Nivel de Rol ID: ${id_rol}.`); // Log histórico automático si hay autor rastreable
    }
  );
});

// ACTUALIZAR LOS METADATOS Y VARIABLES ATRIBUIBLES DE UN USUARIO EXISTENTE EXTERNO (Método PUT dinámico multi-factor)
app.put('/usuarios/:id', (req, res) => { // Genera la Ruta PUT hacia URI interna /usuarios portando y enlazando conjuntivamente un componente de parámetro referencial subyacente wildcard paramétrico literal '/:id' para constatar individualizada y unitariamente inequívocamente a cual único usuario existente se le va a castigar mutando su realidad relacional
  const { id } = req.params; // Saca, extrae e individualiza nominalmente el parámetro puro indexado integral literal forzado dentro de la URl misma HTTP enrutada al resolver la expresión estática
  const { nombre, correo, contrasena, id_rol } = req.body; // Cosecha e interpreta descriptivamente la envoltura útil desde adentro profundo del cuerpo adjuntado original (body form JSON inyectado)

  if (contrasena && contrasena.trim() !== '') { // Verifica e inspecciona transversal y activamente si viajó información nueva textual verídica procesable subyacente alojada intencionadamente en el espacio crudo de "contraseña", descalificando programaticamente y evadiendo de antemano el hipotético cruce de strings artificialmente elaborados pero funcionalmente inútiles no vacíos (Ej. puros espacios inertes)
    db.query( // Procede a ejecutar contundentemente macro-tarea UPDATE de reemplazo incombustible en todos unificadamente y cada uno de los campos expuestos de control sistémico (Incluyendo radical y unilateralmente por ende la sobreescritura estricta sin compasión criptográfica pre-hasheada en claro de la contraseña vital relacional del objetivo humano asignado en el wildcard base fundamental identificable indexadamente)
      'UPDATE usuario SET nombre = ?, correo = ?, contrasena = ?, id_rol = ? WHERE id_usuario = ?', // Plantilla query string forjada
      [nombre, correo, contrasena, id_rol, id], // Distribuye ordenadamente las facetas mutadas e íntegras en conjunto al identificativo que asienta la métrica limitante en conjunción resolutoria posicional a un único respectivo sufijo unitario originario paramétrico id final de línea base condicional limitativo condicionado restrictivamente que encaja herméticamente la ineludible condición inquebrantable de parada de scope operativo limitrofe totalitario (Clausula fundamental WHERE restrictiva)
      (err) => { // Funcion manejadora subyacente lambda callback
        if (err) return res.status(500).json({ mensaje: 'Error al actualizar usuario', error: err }); // Escape prematuro por default e interrupción forzada natural ante eventual manifestación física no controlable a eventual avería catastrofíla MySQL local (Status 500 Code)
        res.json({ mensaje: 'Usuario actualizado con éxito' }); // Suministra luz verde y autorización moral afirmativa generalizada con estatus 200 resolutivo estático exitoso pleno definitivo hacia el entorno espectral del marco renderizado componente del front end cliente terminal UI
        const adminId = req.headers['x-usuario-id']; // Inspecciona el encabezado encubierto Header intrínseco inyectado artificialmente previamenten por interceptor Intercept-Like frontend para recuperar al autor admin verazmente
        if(adminId) registrarMovimiento(adminId, null, 'ACTUALIZACION_USUARIO', `Modificación de Perfil. ID afectado: ${id}. Nuevos datos -> Nombre: ${nombre}, Correo: ${correo}, Rol ID: ${id_rol}. (Contraseña modificada)`); // Bitácora y libro log operativo incuestionable explícito auditado internamente en formato legible texto libre natural alertando y delatando intencionalmente cambios drásticos inmiscuibles profundamente intrusivos e invasivos vitalmente operacionales a la infraestructura original ajena incluyendo recambio rotacional directo de credenciales de seguridad limitantes claves (contraseñas mutantes reseteadas autoritariamente)
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

// ELIMINAR un usuario DE FORMA PERMANENTE (Método DELETE destructivo)
app.delete('/usuarios/:id', (req, res) => { // Enruta peticiones Delete apuntando a un wildcard dinámico :id discriminador 
  const { id } = req.params; // Extrae el número identificador del segmento URL
  db.query('DELETE FROM usuario WHERE id_usuario = ?', [id], (err) => { // Ejecuta sentencia irrecuperable paramétrica de borrado físico del registro en tabla 'usuario'
    if (err) return res.status(500).json({ mensaje: 'Error al eliminar usuario', error: err }); // Fracaso por llave foránea atada o fallo motor MySQL
    res.json({ mensaje: 'Usuario eliminado con éxito' }); // Éxito en borrado
    const adminId = req.headers['x-usuario-id']; // Identificador del autor (El administrador que presionó el botón de borrado)
    if(adminId) registrarMovimiento(adminId, null, 'ELIMINACION_USUARIO', `Eliminación permanente de cuenta de usuario. ID del usuario erradicado: ${id}.`); // Bitácora de extrema sensibilidad para justificar la desaparición de usuarios (Traceability total)
  });
});

// --- RUTAS DE CONSULTA PARA COMBOS Y BUSCADORES DE LA UI ---
// OBTENER el catálogo íntegro de dependencias departamentales registradas en el sistema orgánico de la UAPA
app.get('/dependencias', (req, res) => { // Endpoint genérico de lectura /dependencias
  db.query('SELECT * FROM dependencia', (err, results) => { // Lectura masiva simple del catálogo
    if (err) return res.status(500).json({ error: err }); // Fallback control de fallo base de datos
    res.json(results); // Envía los objetos array formados
  });
});

// OBTENER la lista inamovible estructural física de recintos y sub-sedes universitarias
app.get('/recintos', (req, res) => { // Recurso de extracción GET '/recintos'
  db.query('SELECT * FROM recinto', (err, results) => { // Barrido general para alimentar un Selector/Combobox
    if (err) return res.status(500).json({ error: err }); // Handler de error de base de datos
    res.json(results); // Serializa resultados a text/json
  });
});

// --- MÓDULO PRINCIPAL DE GESTIÓN DE EVENTOS (CORE EMPRESARIAL) ---
// CREAR UN NUEVO EVENTO MACRO INCLUYENDO PRESUPUESTO POA Y LOGÍSTICA COMPLEJA
app.post('/eventos', async (req, res) => { // Declaración Async para el Endpoint transversal de generación de eventos POST
  const { // Extracción destructurada colosal del objeto JSON multipartito y denso que viaja del formulario del Frontend hacia el servidor Node
    nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin,
    cantidad_asistentes, tipo_evento, monto_poa, moneda,
    id_usuario, id_dependencia, id_recinto,
    detalles_corporativos, alimentos, observaciones
  } = req.body; // Volcado desde variable Request Body

  // Variables inicializadoras matemáticas de pre-calculo en caso de requerirse coversión divisa Extranjera -> Local (DOP)
  let tasa_cambio = 1; // Base multiplicadora natural neutra por defecto (Factor 1.0 = Peso Dominicano)
  let monto_dop = 0; // Contenedor vacío preparado para amparar el valor monetario real transformado a DOP 
  
  const montoPOA = parseFloat(monto_poa) || 0; // Extrae forzosamente y parsea estricto a tipo numérico de coma flotante la solicitud del fondo. Si llega falso/indefinido se anula a cero puro.

  try {
    const dbPromise = db.promise();

    // --- VALIDACIÓN DE CONFLICTO DE HORARIOS ---
    const conflictQuery = `
      SELECT id_evento, nombre 
      FROM evento 
      WHERE estado != 'Rechazado' 
        AND id_recinto = ? 
        AND (fecha_inicio <= ? AND fecha_fin >= ?)
        AND (hora_inicio < ? AND hora_fin > ?)
    `;
    const [conflictos] = await dbPromise.query(conflictQuery, [
      id_recinto, 
      fecha_fin, fecha_inicio, 
      hora_fin, hora_inicio
    ]);

    if (conflictos.length > 0) {
      return res.status(409).json({ 
        mensaje: `Existe un conflicto de horario. El recinto ya tiene programado el evento "${conflictos[0].nombre}" (#EVT-${conflictos[0].id_evento}) en esa misma fecha y hora.`
      });
    }
  } catch (err) {
    return res.status(500).json({ mensaje: 'Error al verificar conflictos de horario', error: err.message });
  }

  // MOTOR MULTIMONEDA PARA ESTIMACIÓN FINANCIERA
  if (montoPOA > 0) { // Dispara la rutina cambiaria SÓLO si es que formalmente el usuario digitó un subsidio POA diferente a cero
    if (moneda && moneda !== 'DOP') { // Sub-evalúa si esa solicitud no corresponde deliberadamente a la moneda base matricial local nativa 'DOP'
      try { // Abre bloque Try-Catch para gobernar las peticiones asincrónicas a API externas sobre variables ajenas de valor cambiario global
        const fetchRes = await fetch(`https://open.er-api.com/v6/latest/${moneda}`); // Conecta con la API de Divisas para apuntando a base (Ej USD/EUR)
        const data = await fetchRes.json(); // Serializa y traduce localmente la telaraña JSON devuelta por la API bursátil
        tasa_cambio = data.rates.DOP || 1; // Localiza específicamente la paridad de la moneda Foránea VERSUS el Peso DOP. Si la API falla, por seguridad de redondeo regresa a 1 DOP.
      } catch (err) { // Captura de la caída de conexión de API
        console.error("Error al obtener tasa de cambio:", err); // Expresa advertencia de error
      }
    }
    monto_dop = montoPOA * tasa_cambio; // Efectúa computacionalmente la conversión multiplicativa real: Moneda Extranjera * Valor Peso DOP al día presente y la ancla estáticamente a la variable
  }

  // --- COMPROBACIÓN CONTABLE DEL PLAN OPERATIVO ANUAL (POA FISCAL) ---
  // Comprobar estrictamente si existe en vigencia temporal real un POA activo para deducir directamente y sin fallos
  let id_poa_activo = null; // Inicializa apuntador en nulo esperando asignación
  if (montoPOA > 0) { // Entra en este loop fiscal restrictivo si hay dinero físico involucrado a deducir de universidad
    try {
      const dbPromise = db.promise(); // Fabrica e instancia un Wrapper de Promesas moderno sobre el pool DB de callbacks clásico MySQL2 nativo
      // Obtiene como en un select estricto al POA matriz madre que envuelva entre sus fechas de existencia temporal al inicio perenne cronológico de este Evento
      const [poas] = await dbPromise.query(
        "SELECT id_poa, monto_disponible FROM poa_fiscal WHERE fecha_inicio <= ? AND fecha_fin >= ? ORDER BY id_poa DESC LIMIT 1",
        [fecha_inicio, fecha_inicio] // Inyecta recursivamente la misma variable paramétrica de arranque del evento
      );
      if (poas.length > 0) { // Revisa lógicamente post query si halló ciertamente alguna cuenta contable madre capaz de auspiciar 
        id_poa_activo = poas[0].id_poa; // Asigna e ilumina afirmativamente a la variable superior nula el ID del POA fiscal matriculado 
        if (parseFloat(poas[0].monto_disponible) < monto_dop) { // Realiza confrontación algoritmica matemática: Resta hipotética para averiguar si el saldo del POA banca alcanza para el monto solitado del Evento. 
          return res.status(400).json({ mensaje: 'Presupuesto POA insuficiente para este monto en la fecha del evento.' }); // Deniega de forma inmediata un fallo fatal cliente debido a insolvencia POA calculada en vivo
        }
      } else { // Bifuración negativa en caso de que el universo carezca totalmente de fondo POA general 
        return res.status(400).json({ mensaje: 'No hay un año fiscal registrado que coincida con la fecha del evento para asignar POA.' }); // Alarma la ausencia de configuraciones base POA para sostén
      }
    } catch (err) { // Evita que caiga la red
      return res.status(500).json({ mensaje: 'Error verificando POA', error: err.message }); // Falla interna de la comprobacion promise db
    }
  }

  // --- INSERCIÓN EN TABLA PADRE: EVENTO ---
  db.query( // Si la transacción superó incólume las verificaciones monetarias pasadas, comienza el registro físico vital de la solicitud cruda en evento
    `INSERT INTO evento (nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin,
      cantidad_asistentes, tipo_evento, monto_poa, moneda, id_usuario, id_dependencia, id_recinto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, // Estructura un insert multi-paramétrico estricto de valores
    [nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin,
      cantidad_asistentes, tipo_evento, monto_poa, moneda, id_usuario, id_dependencia, id_recinto], // Despliega la matriz asociativa estricta hacia SQL crudo nativo
    (err, result) => { // Callback lambda
      if (err) return res.status(500).json({ mensaje: 'Error al crear evento', error: err }); // Escape MySQL error
      const id_evento = result.insertId; // Recoge inmediatamente el AutoIncrement único adjudicado a la tabla madre (Llave primaria evento)

      // --- INSERCIONES DE RELACIONES Y TABLAS HIJAS SUB-DIMENSIONADAS (RELACIONES N:M MULTIPLES) ---
      if (detalles_corporativos && detalles_corporativos.length > 0) { // Evalúa de existir si el usuario tildó casillas corporativas checkbox
        const valoresCorp = detalles_corporativos.map(tipo => [id_evento, tipo]); // Cosecha subarreglo asociado a cada foraneo
        db.query('INSERT INTO detalle_corporativo (id_evento, tipo) VALUES ?', [valoresCorp], () => { }); // BulkInsert array de multi-datos M:N
      }

      if (alimentos && alimentos.length > 0) { // Evalúa si la ui envió lista selecta de alimentos (relación multijoin)
        db.query('SELECT id_alimento, nombre FROM alimento', (err2, alimentosDB) => { // Requiere urgentemente leer diccionario matriz Alimentos base de la BD (para empatar String vs Int)
          if (!err2) { // De sobrevivir el query normal
            const valores = []; // Inicializa contenedor puro
            alimentos.forEach(nombreAlimento => { // Loop sobre array ui de Strings de comida
              const encontrado = alimentosDB.find(a => a.nombre === nombreAlimento); // Ubica minuciosamente en el array extraído el Match por nombre textual
              if (encontrado) valores.push([id_evento, encontrado.id_alimento]); // Emparejando Clave foránea de evento con Clave foránea del alimento
            });
            if (valores.length > 0) { // Inserta final si armó data válida 
              db.query('INSERT INTO evento_alimento (id_evento, id_alimento) VALUES ?', [valores], () => { }); // Registra tabla conectora pivot evento_alimento
            }
          }
        });
      }

      if (observaciones && observaciones.trim() !== '') { // Filtra preventivamente descripciones largas de montaje si viajan vacías
        db.query('INSERT INTO detalle_montaje (id_evento, descripcion) VALUES (?, ?)', [id_evento, observaciones], () => { }); // Guarda comentario largo atado
      }

      // --- ACTUALIZACIÓN DE ESTADOS CONTABLES DINÁMICOS (SUSTRACCIÓN POR RESERVA FINANCIERA POA) ---
      if (montoPOA > 0 && id_poa_activo) { // Solo si hay monto y se validó exitosamente el id activo subyacente del poa fiscal vivo anual
        db.query( // Dispara transacción a sub-tabla ledger de historial y log de rastreo financiero poa_movimiento
          `INSERT INTO poa_movimiento (id_poa, id_evento, monto_solicitado_original, moneda_original, tasa_cambio, monto_descontado_dop, estado)
           VALUES (?, ?, ?, ?, ?, ?, 'Pendiente')`, // Inyecta datos cambiarios calculados estáticamente en este milisegundo al cambio del día marcado 'Pendiente' hasta decisión de los gestores
          [id_poa_activo, id_evento, montoPOA, moneda || 'DOP', tasa_cambio, monto_dop],
          (poaErr) => { // Espera respuesta asíncrona DB
            if (!poaErr) { // Y solo si no hubo fatal error de insercion en bitacora POA
               // Realiza el Descuento final FÍSICO Y MATEMÁTICO REAL de la base central sustrayendo sin compasión el estimado para bloquear el dinero (reserva contable real en caliente UPDATE)
               db.query("UPDATE poa_fiscal SET monto_disponible = monto_disponible - ? WHERE id_poa = ?", [monto_dop, id_poa_activo], ()=>{}); // Deduce
            }
          }
        );
      }

      // CONCLUSIÓN DE MÚLTIPLES HITOS INSERCIONALES EXITOSA (END)
      res.status(201).json({ mensaje: 'Evento creado con éxito', id_evento }); // Devuelve luz verde general a todo el engranaje HTTP STATUS Real (201)
      const reqUserId = req.headers['x-usuario-id'] || id_usuario; // Extrae identificativo header unívoco para asentar bitácora
      if(reqUserId) registrarMovimiento(reqUserId, null, 'CREACION_EVENTO', `Nueva Solicitud de Evento. ID generado: ${id_evento}. Título: "${nombre}".`); // Fija auditablemente el rastro sistemático de creación
    }
  );
});

// ── PLAN OPERATIVO ANUAL (POA) ─────────────────────────
// CREAR UN NUEVO PRESUPUESTO ANUAL POA (POST)
app.post('/poa', (req, res) => { // Declara la ruta POST '/poa'
  const { fecha_inicio, fecha_fin, monto_total } = req.body; // Extrae datos del cuerpo de solicitud 
  if (!fecha_inicio || !fecha_fin || !monto_total) return res.status(400).json({ mensaje: 'Datos incompletos.' }); // Validación base de variables nulas

  const reqUserId = req.headers['x-usuario-id'] || null; // Identificar autor del movimiento 

  db.query( // Realiza la inserción matriz del contenedor fiscal
    'INSERT INTO poa_fiscal (fecha_inicio, fecha_fin, monto_total, monto_disponible, creado_por) VALUES (?, ?, ?, ?, ?)',
    [fecha_inicio, fecha_fin, monto_total, monto_total, reqUserId], // Al nacer, el monto disponible es siempre íntegra y matemáticamente igual al total
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message }); // Escape en caso de error SQL
      res.status(201).json({ mensaje: 'POA Creado', id_poa: result.insertId }); // Respuesta exitosa con ID insertado
      if(reqUserId) registrarMovimiento(reqUserId, null, 'CREACION_POA', `Nuevo presupuesto POA por ${monto_total}.`); // Log bitácora obligatoria
    }
  );
});

// OBTENER TODOS LOS PLANES POA EXISTENTES Y SUS MOVIMIENTOS HISTÓRICOS (GET)
app.get('/poa', (req, res) => { // Declara el endpoint de listado maestro GET '/poa'
  db.query('SELECT * FROM poa_fiscal ORDER BY fecha_inicio DESC', (err, poas) => { // Busca las carpetas contables matrices ordenadas por la más reciente
    if (err) return res.status(500).json({ error: err.message }); // Handlder err
    
    // Anida asincrónicamente una segunda consulta para obtener todos los sub-registros de consumición contable ('poa_movimiento')
    db.query(`
      SELECT m.*, e.nombre as nombre_evento, e.modalidad, e.fecha_inicio, e.fecha_fin,
             e.hora_inicio, e.hora_fin, e.cantidad_asistentes, e.tipo_evento,
             u.nombre as solicitante, r.nombre as recinto
      FROM poa_movimiento m
      JOIN evento e ON m.id_evento = e.id_evento
      LEFT JOIN usuario u ON e.id_usuario = u.id_usuario
      LEFT JOIN recinto r ON e.id_recinto = r.id_recinto
      ORDER BY m.fecha_movimiento DESC -- Trae todo con un Left Join masivo para armar la tabla historial de egresos UI
    `, (errMov, movs) => {
      if (errMov) return res.status(500).json({ error: errMov.message }); // Fallback
      res.json({ poas, movimientos: movs }); // Responde entregando un Objeto JSON Compuesto: Array de POAs y Array de Movimientos
    });
  });
});

// ACTUALIZAR APROBACIÓN O RECHAZO DE UN DESCUENTO POA INDIVIDUAL (PUT)
app.put('/poa/movimiento/:id/estado', (req, res) => { // Metodo PUT apuntando a un elemento del ledger directamente
  const { id } = req.params; // Extrae ID URL param
  const { estado, motivo_rechazo } = req.body;  // Rescata el veredicto directivo ('Aprobado', 'Rechazado') y su justificación si la hubiese
  const reqUserId = req.headers['x-usuario-id']; // Validador autor humano en auditoria

  db.query('SELECT * FROM poa_movimiento WHERE id_movimiento = ?', [id], (err, results) => { // Lee el estado real anterior anclado en BD
    if (err || results.length === 0) return res.status(404).json({ mensaje: 'Movimiento no encontrado' }); // Validacion de no vacio
    
    const mov = results[0]; // Aparta var referencial
    if (mov.estado === estado) return res.json({ mensaje: 'Sin cambios en el estado' }); // Si el estado es identico, salta la iteracion para ahorrar recursos

    db.query('UPDATE poa_movimiento SET estado = ?, motivo_rechazo = ? WHERE id_movimiento = ?',  // Sobreescribe el log histórico contable
      [estado, motivo_rechazo || null, id],  // Pasa los parametros de justificación y estado nuevo
      (errUpdate) => {
        if (errUpdate) return res.status(500).json({ error: errUpdate.message }); // Fallo SQL update
        
        // MOTOR DE REINTEGRO/DEDUCCIÓN CONDICIONAL MULTIDIRECCIONAL (CONTABILIDAD INVERSA VIVA)
        // Si el estado anterior NO era Rechazado (Ej. Pendiente) y ahora se castiga como 'Rechazado', devolver integro el dinero a la bolsa POA
        if (estado === 'Rechazado' && mov.estado !== 'Rechazado') {
          db.query('UPDATE poa_fiscal SET monto_disponible = monto_disponible + ? WHERE id_poa = ?', [mov.monto_descontado_dop, mov.id_poa]); // Suma restauradora Update a base principal
        }
        // A la inversa: Si el estado anterior sí era Rechazado (dinero ya regresado al gran pool) y ahora por error o correcién es 'Aprobado/Pendiente', volver a restar el dinero fugazmente y bloquearlo
        else if (mov.estado === 'Rechazado' && estado !== 'Rechazado') {
          db.query('UPDATE poa_fiscal SET monto_disponible = monto_disponible - ? WHERE id_poa = ?', [mov.monto_descontado_dop, mov.id_poa]); // Resta deductiva Update base principal real
        }

        res.json({ mensaje: 'Estado del movimiento POA actualizado' }); // Success output client
        if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_POA', `Movimiento ${id} cambiado a ${estado}.`); // Bitácora audit trail
    });
  });
});
// ACTUALIZAR EVENTO EXISTENTE CRUD METADATA Y SUB-TABLAS (PUT)
app.put('/eventos/:id', async (req, res) => { // Asignación de Endpoint dinámico
  const { id } = req.params; // Extrae ID target paramétrico
  const { nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin, cantidad_asistentes, tipo_evento, id_recinto, id_dependencia, detalles_corporativos, alimentos, observaciones, monto_poa, moneda } = req.body; // Cosecha colosal json struct body
  const reqUserId = req.headers['x-usuario-id']; // Autor humano rastreable

  if (!id_recinto || !id_dependencia) { // Filtro de salvaguarda relacional Foránea fundamental (Anti-Crash MySQL error 1048 Column cannot be null)
    return res.status(400).json({ mensaje: 'Faltan campos obligatorios: Recinto o Dependencia.' });
  }

  try {
    const dbPromise = db.promise();

    // --- VALIDACIÓN DE CONFLICTO DE HORARIOS ---
    const conflictQuery = `
      SELECT id_evento, nombre 
      FROM evento 
      WHERE estado != 'Rechazado' 
        AND id_evento != ?
        AND id_recinto = ? 
        AND (fecha_inicio <= ? AND fecha_fin >= ?)
        AND (hora_inicio < ? AND hora_fin > ?)
    `;
    const [conflictos] = await dbPromise.query(conflictQuery, [
      id,
      id_recinto, 
      fecha_fin, fecha_inicio, 
      hora_fin, hora_inicio
    ]);

    if (conflictos.length > 0) {
      return res.status(409).json({ 
        mensaje: `Existe un conflicto de horario. El recinto ya tiene programado el evento "${conflictos[0].nombre}" (#EVT-${conflictos[0].id_evento}) en esa misma fecha y hora.`
      });
    }
  } catch (err) {
    return res.status(500).json({ mensaje: 'Error al verificar conflictos de horario', error: err.message });
  }

  try {
    const dbPromise = db.promise();

    // --- PRE-CALCULO MONETARIO ---
    const montoPOA = parseFloat(monto_poa) || 0;
    let tasa_cambio = 1;
    let monto_dop = 0;

    if (montoPOA > 0) {
      if (moneda && moneda !== 'DOP') {
        try {
          const fetchRes = await fetch(`https://open.er-api.com/v6/latest/${moneda}`);
          const data = await fetchRes.json();
          tasa_cambio = data.rates.DOP || 1;
        } catch (e) {
          console.error("Error tasa cambio:", e);
        }
      }
      monto_dop = montoPOA * tasa_cambio;
    }

    // --- POA VERIFICACION PREVIA DE FONDOS Y RECONCILIACIÓN ---
    const [movs] = await dbPromise.query("SELECT * FROM poa_movimiento WHERE id_evento = ?", [id]);
    const movPrevio = movs.length > 0 ? movs[0] : null;
    let id_poa_activo = movPrevio ? movPrevio.id_poa : null;

    if (montoPOA > 0) {
      if (!id_poa_activo) {
        // Encontrar POA activo si no había movimiento previo
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
      } else {
        // Verificar si los fondos alcanzan asumiendo el reembolso del movimiento previo
        const [poas] = await dbPromise.query("SELECT monto_disponible FROM poa_fiscal WHERE id_poa = ?", [id_poa_activo]);
        if (poas.length > 0) {
          let fondosActuales = parseFloat(poas[0].monto_disponible);
          if (movPrevio.estado !== 'Rechazado') {
            fondosActuales += parseFloat(movPrevio.monto_descontado_dop);
          }
          if (fondosActuales < monto_dop) {
            return res.status(400).json({ mensaje: 'Presupuesto POA insuficiente para cubrir el nuevo monto solicitado.' });
          }
        }
      }
    }

    // --- ACTUALIZACION DEL EVENTO ---
    const sql = `UPDATE evento SET 
      nombre = ?, modalidad = ?, fecha_inicio = ?, fecha_fin = ?, 
      hora_inicio = ?, hora_fin = ?, cantidad_asistentes = ?, 
      tipo_evento = ?, id_recinto = ?, id_dependencia = ?,
      monto_poa = ?, moneda = ?
      WHERE id_evento = ?`;
    const params = [nombre, modalidad, fecha_inicio, fecha_fin, hora_inicio, hora_fin, cantidad_asistentes, tipo_evento, id_recinto, id_dependencia, monto_poa, moneda, id];
    
    await dbPromise.query(sql, params);

    // --- APLICACION DE RECONCILIACION CONTABLE (POA) ---
    if (movPrevio) {
      if (movPrevio.estado !== 'Rechazado') {
        await dbPromise.query("UPDATE poa_fiscal SET monto_disponible = monto_disponible + ? WHERE id_poa = ?", [movPrevio.monto_descontado_dop, movPrevio.id_poa]);
      }
      if (montoPOA > 0) {
        await dbPromise.query("UPDATE poa_fiscal SET monto_disponible = monto_disponible - ? WHERE id_poa = ?", [monto_dop, movPrevio.id_poa]);
        await dbPromise.query(
          "UPDATE poa_movimiento SET monto_solicitado_original = ?, moneda_original = ?, tasa_cambio = ?, monto_descontado_dop = ?, estado = 'Pendiente', motivo_rechazo = NULL WHERE id_movimiento = ?", 
          [montoPOA, moneda || 'DOP', tasa_cambio, monto_dop, movPrevio.id_movimiento]
        );
      } else {
        await dbPromise.query("DELETE FROM poa_movimiento WHERE id_movimiento = ?", [movPrevio.id_movimiento]);
      }
    } else {
      if (montoPOA > 0 && id_poa_activo) {
        await dbPromise.query(
          `INSERT INTO poa_movimiento (id_poa, id_evento, monto_solicitado_original, moneda_original, tasa_cambio, monto_descontado_dop, estado) VALUES (?, ?, ?, ?, ?, ?, 'Pendiente')`,
          [id_poa_activo, id, montoPOA, moneda || 'DOP', tasa_cambio, monto_dop]
        );
        await dbPromise.query("UPDATE poa_fiscal SET monto_disponible = monto_disponible - ? WHERE id_poa = ?", [monto_dop, id_poa_activo]);
      }
    }

    // --- LIMPIEZA M:N --- 
    // Usamos callbacks normales para operaciones no-bloqueantes de satélites
    db.query('DELETE FROM detalle_corporativo WHERE id_evento = ?', [id], () => {
      if (detalles_corporativos && detalles_corporativos.length > 0) {
        const valoresCorp = detalles_corporativos.map(tipo => [id, tipo]);
        db.query('INSERT INTO detalle_corporativo (id_evento, tipo) VALUES ?', [valoresCorp], () => { });
      }
    });

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

    db.query('DELETE FROM detalle_montaje WHERE id_evento = ?', [id], () => {
      if (observaciones && observaciones.trim() !== '') {
        db.query('INSERT INTO detalle_montaje (id_evento, descripcion) VALUES (?, ?)', [id, observaciones], () => { });
      }
    });

    res.json({ mensaje: 'Evento actualizado correctamente y POA conciliado' });
    if(reqUserId) registrarMovimiento(reqUserId, null, 'EDICION_EVENTO', `Evento ${id} actualizado. Presupuesto nuevo: ${montoPOA} ${moneda || 'DOP'}.`);

  } catch (err) {
    console.error('Error en reconciliacion PUT /eventos:', err.message);
    return res.status(500).json({ mensaje: 'Error al actualizar evento o conciliar POA', error: err.message });
  }
});

// ── EVENTOS — OBTENER TODOS (LECTURA ADMINISTRADOR/SISTEMA) ────────────────────────────
app.get('/eventos', (req, res) => { // Declara la gran ruta HTTP GET '/eventos'
  const { usuario_id } = req.query; // Permite discriminar la vista extrayendo el parametro de busqueda URL Query String param
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
     LEFT JOIN recinto     r ON e.id_recinto     = r.id_recinto`; // Enorme Query multi-dimensional con Selects Anidados (Subqueries) para extraer relaciones M:N serializadas en strings separados por comas usando GROUP_CONCAT, evitando duplicar filas.
  
  const params = []; // Lista local vacia de bindings paramétricos a inyectar seguros en BD
  if (usuario_id) { // Si el front end explicitó a quien pertenece...
    sql += ` WHERE e.id_usuario = ?`; // Filtra contundentemente por ID de su creador usando WHERE
    params.push(usuario_id); // Alimenta el stack de valores inyectables 
  }

  sql += ` ORDER BY e.fecha_creacion DESC`; // Ordena cronológicamente descendente por default

  db.query(sql, params, (err, results) => { // Lectura final
    if (err) return res.status(500).json({ error: err.message }); // Ataja de inmediato error MySQL
    res.json(results); // Serializa masivamente el conjunto crudo parseandolo transparentemente en un modelo JSON legible de Array 
  });
});

// ── EVENTOS — CALENDARIO PRIVADO (UI SCHEDULING INTERFACE) ───────────────────────
app.get('/calendario-eventos', (req, res) => { // Endpoint dedicado a despachar metadatos para llenar componentes gráficos tipo FullCalendar o BigCalendar
  const { usuario_id } = req.query; // ID del usuario local que activamente consulta (Viene del JWT Decode Front o Token Storage)
  
  const sql = `
    SELECT 
      e.id_evento, e.nombre, e.fecha_inicio, e.fecha_fin, e.id_usuario,
      r.nombre AS recinto,
      IF((SELECT COUNT(*) FROM servicio_audiovisual sa WHERE sa.id_evento = e.id_evento AND sa.estado != 'Rechazado') > 0, 1, 0) AS necesita_audiovisual
    FROM evento e
    LEFT JOIN recinto r ON e.id_recinto = r.id_recinto
    WHERE e.estado != 'Rechazado' -- Evade y excluye completamente del dibujo agendado aquellos planes flagrantemente rechazados
  `; // Select parcial que ignora data confidencial administrativa e incluye banderas booleanas IF

  db.query(sql, (err, results) => { // Lanza Query
    if (err) return res.status(500).json({ error: err.message }); // Error Handling

    const processed = results.map(evt => { // Despliega iterador funcional Map sobre matriz bruta para formatear un nuevo objeto anónimo calibrado para React-Big-Calendar Standard
      const esPropio = usuario_id && evt.id_usuario == usuario_id; // Validación booleana analizando Posesión (Si el evento iterado me pertenece o es de alguien ajeno en la red institucional)
      return { // Estructura formal standard object
        id: evt.id_evento, // Asignacion llave
        start: evt.fecha_inicio, // Mapping param start date 
        end: evt.fecha_fin, // Mapping param end date
        title: esPropio ? evt.nombre : "Ocupado", // Censura dinámica: Si es mío revelo titulo, sino aplico etiqueta privada estándar "Ocupado"
        recinto: esPropio ? evt.recinto : "Información Privada", // Censura espacial local
        esPropio: esPropio, // Bandera de propiedad
        necesita_audiovisual: evt.necesita_audiovisual === 1 // Cast int to bool verdadero/falso
      };
    });

    res.json(processed); // Responde el array calibrado final transformado iterativamente
  });
});

// ── EVENTOS — ACTUALIZAR ESTADO GERENCIAL ────────────────────────
app.put('/eventos/:id/estado', (req, res) => { // Edición atómica puramente enfocada en el Workflow Lifecycle Status del evento, usando URI PUT
  const { id } = req.params; // Extrae parámetro
  const { estado } = req.body; // Cosecha la variable a mutar 
  const estadosValidos = ['Pendiente', 'Aprobado', 'Rechazado', 'Finalizado']; // Define array estático constante interno sirviendo como Lista Blanca/Whitelist de validación de negocio
  if (!estadosValidos.includes(estado)) // Caza intentos de asignar estados inexistentes inventados por hackers o bugs  
    return res.status(400).json({ mensaje: 'Estado no válido' }); // Prohibe cambio de estatus corrupto 
  db.query('UPDATE evento SET estado=? WHERE id_evento=?', [estado, id], (err) => { // Impacta BD estrictamente
    if (err) return res.status(500).json({ mensaje: 'Error al actualizar estado', error: err.message }); // Handle
    res.json({ mensaje: 'Estado actualizado con éxito' }); // Terminado okay HTTP Response
    const reqUserId = req.headers['x-usuario-id']; // Quien aprueba/rechaza
    if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_EVENTO', `Resolución de Estado del Evento. El Evento con ID ${id} ha pasado al estado: "${estado}".`); // Trazo logístico
  });
});

// ── EVENTOS — ELIMINAR MANUALMENTE UNA SOLICITUD ─────────────────────────────────
app.delete('/eventos/:id', (req, res) => { // Ruta explícita DELETE masivo de cascada manual
  const { id } = req.params; // Saca var id foránea de URL param
  db.query('DELETE FROM detalle_corporativo WHERE id_evento=?', [id], () => { // Cadena callback 1: Borrado de nodos adjuntos corporativos subyacentes
    db.query('DELETE FROM evento_alimento WHERE id_evento=?', [id], () => { // Cadena callback 2: Borrado de relación de nodos puente alimentos
      db.query('DELETE FROM detalle_montaje WHERE id_evento=?', [id], () => { // Cadena callback 3: Borrado de descripciones anexas de montaje
        db.query('DELETE FROM evento WHERE id_evento=?', [id], (err) => { // Fin de cascada Callback Hell piramidal manual: Extinción del Padre/Tronco Matrix del suceso central
          if (err) return res.status(500).json({ mensaje: 'Error al eliminar evento', error: err.message }); // Falla de sustracción profunda
          res.json({ mensaje: 'Evento eliminado con éxito' }); // Respuesta limpia tras purga
          const reqUserId = req.headers['x-usuario-id']; // Autoria identificativa
          if(reqUserId) registrarMovimiento(reqUserId, null, 'ELIMINACION_EVENTO', `Cancelación y Borrado de Evento. Evento afectado ID: ${id}.`); // Confirmacion Bitacora de borrado de root tree evento
        });
      });
    });
  });
});

// ── AUDIOVISUAL — CREAR SOLICITUD INDEPENDIENTE O AÑEXA ──────────────────────
app.post('/audiovisual', (req, res) => { // Endpoint de generacion POST /audiovisual
  const { id_evento, servicios } = req.body; // Pide llave evento parejada y array puro de necesidades tecnicas
  // servicios será un array de objetos parseados desde JSON front: { equipo: 'Proyector', cantidad: 2, descripcion: '...', ubicacion: '...', observaciones: '...' }

  if (!id_evento || !servicios || servicios.length === 0) { // Cortafuegos de seguridad Anti-Null arrays
    return res.status(400).json({ mensaje: 'Faltan datos requeridos o servicios audiovisuales.' }); // Desprecia peticiones anemicas sin payload util
  }

  // 1. Validar la estricta regla organizacional de 5 días mínimos calendarios requeridos de anticipación técnica 
  db.query('SELECT fecha_inicio FROM evento WHERE id_evento = ?', [id_evento], (err, results) => { // Primero lee fecha planeada matriz
    if (err) return res.status(500).json({ mensaje: 'Error al buscar el evento', error: err.message }); // Caida DB MySQL
    if (results.length === 0) return res.status(404).json({ mensaje: 'Evento no encontrado' }); // ID Foraneo corrupto false / Desaparecido

    const fechaEvento = new Date(results[0].fecha_inicio); // Construye Data Object referencial real calculable apuntando a la fecha evento guardada
    const fechaActual = new Date(); // Constructor dia servidor presente
    // Neutralizar horas nativas exactas para calcular la diferencia de días netos naturales en el calendario correctamente
    fechaEvento.setHours(0, 0, 0, 0); // Vaciado de offset de huso horario truncando a base Date Object a hora muerta media noche absoluta
    fechaActual.setHours(0, 0, 0, 0); // Modificación de calibrado idéntico al pivote actual presente dia

    const diferenciaTiempo = fechaEvento.getTime() - fechaActual.getTime(); // Matematica base de Unix Milisegundos epoch Timestamp gap subtraction
    const diferenciaDias = Math.ceil(diferenciaTiempo / (1000 * 3600 * 24)); // Modulación por modulo division de formula magica de conversion temporal ms->dias naturales enteros (Milisegundo * horas * 24 h)

    if (diferenciaDias < 5) { // Aplicacion Categórica Logica de Negocio UAPA Privada: Implanta politica de cierre y denegación dura
      return res.status(400).json({ // Devuelve HTTP 400 y cancela emision de alerta cortado a la capa visual 
        mensaje: `Políticas institucionales: La solicitud de equipos audiovisuales requiere un mínimo de 5 días de antelación. Faltan ${diferenciaDias} días para el evento.`,
        dias_restantes: diferenciaDias // Adjunta un param int extra aclaratorio para logicas condicionales UI Frontend de React
      });
    }

    // 2. Transaccion pre-condición aceptada: Insertar masivamente los servicios reales limpios pre-filtrados en db con map bulk
    const values = servicios.map(s => { // Generacion del array dimensional anidado usando .map() list traversal function
      // Estructura posicional parametrizada de columnas: (id_evento, tipo_servicio, estado, cantidad, ubicacion, observaciones)
      return [ // Bracket array sub-indice
        id_evento, // Foreign key link principal
        s.equipo, // Item string nominal del equipo
        'Pendiente', // Estatus text inmutable forzado al momento de creación
        s.cantidad || 1,  // Cantidad solicitada (Fallo positivo asume 1 unidad como valor mínimo estándar base)
        s.ubicacion || '', // String metadata location text field
        s.observaciones || '' // Metadata comments string field
      ];
    });

    db.query('INSERT INTO servicio_audiovisual (id_evento, tipo_servicio, estado, cantidad, ubicacion, observaciones) VALUES ?', [values], (errInsert) => { // Ejecuta Bulkinsert masivo blindado de la matriz preparada posicional
      if (errInsert) return res.status(500).json({ mensaje: 'Error al registrar servicios', error: errInsert.message });
      res.status(201).json({ mensaje: 'Solicitud audiovisual registrada con éxito' });
      const reqUserId = req.headers['x-usuario-id'];
      if(reqUserId) registrarMovimiento(reqUserId, null, 'CREACION_AUDIOVISUAL', `Se levantó una Solicitud de Servicios Audiovisuales. Evento Asociado ID: ${id_evento}. Equipos requeridos: ${servicios.map(s => s.equipo).join(', ')}.`);
    });
  });
});

// ── AUDIOVISUAL — OBTENER TODAS LAS SOLICITUDES MATRICES ─────────────────────────
app.get('/audiovisual', (req, res) => { // Endpoint de lectura gerencial administrativa GET /audiovisual
  const { usuario_id } = req.query; // Permite discriminar la vista extrayendo el parametro de filtro por owner URL Query String param
  let sql = `SELECT 
       s.id_servicio, s.id_evento, s.tipo_servicio, s.estado AS estado_av,  -- Renombramiento Alias para evadir colisiones semánticas con estado del root evento
       s.cantidad, s.ubicacion, s.observaciones,
       e.nombre AS nombre_evento, e.fecha_inicio, r.nombre AS recinto,
       e.id_usuario, u.nombre AS nombre_usuario
     FROM servicio_audiovisual s
     JOIN evento e ON s.id_evento = e.id_evento -- Amarre fuerte obligatorio (INNER JOIN) con la matrix de Evento (El servicio no puede existir huérfano)
     LEFT JOIN recinto r ON e.id_recinto = r.id_recinto -- Amarre débil izquierdo con su recinto posicional
     LEFT JOIN usuario u ON e.id_usuario = u.id_usuario`; // Amarre débil izquierdo con la firma de creador
  
  const params = []; // Colección de inyección segura vacía
  if (usuario_id) { // Condicional discriminador: Si hay ID, solo muestro su pedazo de la torta de Data
    sql += ` WHERE e.id_usuario = ?`; // Filtro subyacente de la Foreign Key del evento padre
    params.push(usuario_id); // Alimento de Bindings
  }

  sql += ` ORDER BY s.id_servicio DESC`; // Disposición lógica natural descendente para ver lo nuevo en la cima (LIFO visual)

  db.query(sql, params, (err, results) => { // Despliegue de DB callback
    if (err) return res.status(500).json({ error: err.message }); // Ataja de inmediato error MySQL

    const parsedResults = results.map(row => { // Algoritmo de mapeo puramente preventivo
        // Fallback robusto en caso de que aún exista data comprimida vieja incrustada en BD heredada del diseño antiguo (ej: Proyector|Cant:2|Ubic:A)
        let equipo = row.tipo_servicio; // Intento 1: Asume estructura moderna normalizada 
        let cant = row.cantidad;
        let ubic = row.ubicacion;
        let obs = row.observaciones;

        if (row.tipo_servicio.includes('|Cant:')) { // Patrón RegEx-like de cacería indicando si este registro particular obedece al esquema viejo pipe concat String V1
          const parts = row.tipo_servicio.split('|'); // Despedaza la cadena cruda separándola nativamente por símbolo Pipe
          equipo = parts[0]; // Extrae el nombre crudo de la máquina de manera aislada en slot 0
          if (parts[1]) cant = parts[1].replace('Cant:', ''); // Extrae e higieniza removiendo texto prefijo cant en slot 1
          if (parts[2]) ubic = parts[2].replace('Ubic:', ''); // Remueve prefijo Ubic en slot 2
          if (parts[3]) obs = parts[3].replace('Obs:', ''); // Extrae anotaciones finales en slot 3
        }

        return { // Retorna y construye al paso dinámico on-the-fly el JSON Object sanitizado definitivo estandarizado listo para inyección Front UI
          id_servicio: row.id_servicio, // Puntero primario del requerimiento unitario equipo
          id_evento: row.id_evento, // Puntero FK anexo Evento
          nombre_evento: row.nombre_evento, // Texto
          fecha_evento: row.fecha_inicio, // Fecha programada para uso real calendario
          estado_av: row.estado_av, // Situacional status aislado solo de este equipo (Aprob/Rech)
          equipo: equipo, // Nombre de maquina
          cantidad: cant || 1, // Fallback si era NaN a 1 
          ubicacion: ubic || '', // String Vacio en caso Null
          observaciones: obs || '', // Comments String
          nombre_usuario: row.nombre_usuario || '' // Autor
        };
      });

      res.json(parsedResults); // Envia lista saneada parseada global al receptor React Hook
    }
  );
});

// ── AUDIOVISUAL — ACTUALIZAR ESTADO ITEM ÚNICO ─────────────────────
app.put('/audiovisual/:id/estado', (req, res) => { // Endpoint de mutabilidad dinámica de micro-estatus PUT Unitario individual 
  const { id } = req.params; // Desentrama ID URL parameter
  const { estado } = req.body; // Pospone el paquete de decisión estatus
  const estadosValidos = ['Pendiente', 'En revisión', 'Aprobado', 'Rechazado', 'Completado']; // Enumera virtualmente en Node el diccionario de Listas Blancas validadoras lógicas en ram de Estados Aceptables (Previene Injection Attacks de Fake States)

  if (!estadosValidos.includes(estado)) // Caza intentos maliciosos o bugeados de sobre-escritura con estados extraterrestres no contemplados por el core negocio
    return res.status(400).json({ mensaje: 'Estado audiovisual no válido' }); // Detiene ejecucion y repulsa via 400 Bad Request client mistake

  db.query('UPDATE servicio_audiovisual SET estado=? WHERE id_servicio=?', [estado, id], (err, result) => { // Activa UPDATE MySQL de una sola pieza referida apuntando exclusivamente al row especifico del Service Item id
    if (err) { // Handle callback Error
      console.error('Update Error:', err); // Aviso Logger Silencioso NodeJS Host
      return res.status(500).json({ mensaje: 'Error al actualizar estado', error: err.message }); // Rechazo final HTTP Backend down status 500
    }
    console.log(`Update Result for id ${id}:`, result); // Logger satisfactorio de depuracion 
    res.json({ mensaje: 'Estado audiovisual actualizado con éxito', affectedRows: result.affectedRows }); // HTTP response emite cuantas filas exactas se alteraron (deberia ser 1 siempre)
    const reqUserId = req.headers['x-usuario-id']; // Busca el Header oculto del panel admin para ficharlo 
    if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_AUDIOVISUAL', `Resolución de Solicitud Audiovisual. El ticket ID ${id} ha pasado al estado: "${estado}".`); // Trazo logístico oficial de bitácora
  });
});

// ── AUDIOVISUAL — ACTUALIZAR ESTADO (GLOBAL MASIVO POR CLUSTER EVENTO) ─
app.put('/audiovisual/evento/:id_evento/estado', (req, res) => { // Sub-endpoint derivado que apunta al Cluster Superior Agrupador de la familia completa de audiovisuales (El id de su evento padre creador orgánico) en caso que el gerente de audiovisulaes quiera Aprobar masivamente en 1 Clic una canasta de equipos solicitada entera
  const { id_evento } = req.params;  // Pide el Foreign Key id_evento por sobre el Primary id_servicio 
  const { estado } = req.body;  // Absorbe intencion de masa Update Generalizado Global  
  const estadosValidos = ['Pendiente', 'En revisión', 'Aprobado', 'Rechazado', 'Completado']; // Whitelist constante protectora en memoria Node

  if (!estadosValidos.includes(estado)) // Caza Fake States
    return res.status(400).json({ mensaje: 'Estado audiovisual no válido' }); // Return false stop Request 400 bad data payload

  db.query('UPDATE servicio_audiovisual SET estado=? WHERE id_evento=?', [estado, id_evento], (err, result) => { // Sobrescribe implacablemente con una sola Query a N cantidad multiplicada de sub elementos adosados todos coincidentemente a un mismo Foraneo id_evento
    if (err) { // Manejador basico error
      console.error('Update All Error:', err); // Trace terminal error Node JS Process instance PM2
      return res.status(500).json({ mensaje: 'Error al actualizar estado general', error: err.message }); // HTTP Stop error database unreachable
    }
    res.json({ mensaje: 'Estado audiovisual del evento actualizado con éxito', affectedRows: result.affectedRows }); // Respuesta victoriosa HTTP Front 
    const reqUserId = req.headers['x-usuario-id']; // Puntero Header Autor Humano Culpable/Responsable del Click accionador masivamente transformador
    if(reqUserId) registrarMovimiento(reqUserId, null, 'ACTUALIZACION_AUDIOVISUAL_GLOBAL', `Resolución Global de Audiovisual. Los servicios del Evento ID ${id_evento} pasaron al estado: "${estado}".`); // Inscribe de un solo tajo la alteración estructural global en el libro contable de Bitacora Admin Action Logs History Table Auditorial general del sistema.
  });
});

// ── RESTABLECIMIENTO DE CONTRASEÑA (EMAIL FLOW OAUTH BYPASS) ───────
app.post('/solicitar-restablecimiento', (req, res) => { // Endpoint de disparo inicial para flujo "Olvidé mi contraseña"
  const { correo } = req.body; // Extrae el input string del email digitado por el usuario en conflicto

  db.query('SELECT id_usuario FROM usuario WHERE correo = ?', [correo], (err, results) => { // Chequeo de seguridad: Validar si de hecho existe
    if (err) return res.status(500).json({ mensaje: 'Error al consultar la base de datos' }); // Falla de lectura base MySQL
    if (results.length === 0) { // Si el motor retorna Array vacío = El usuario es fantasma o se equivocó al teclear
      return res.status(404).json({ mensaje: 'El correo no está registrado' }); // 404 No encontrado explícito
    }

    // Generar token criptográfico pseudo-aleatorio único de seguridad (Non-guessable Hash string)
    const token = crypto.randomBytes(32).toString('hex'); // Librería Crypto nativa NodeJS: Genera 64 caracteres Hexadecimales
    const expiracion = new Date(Date.now() + 3600000); // 1 hora exacta de validez estricta (Time to live TTL) sumada en formato Milisegundos Epoch a la fecha Actual

    db.query( // Asienta transaccionalmente en la Tabla Temporal el hash y su atadura al correo
      'INSERT INTO restablecimiento_token (correo, token, expiracion) VALUES (?, ?, ?)',
      [correo, token, expiracion], // Pasa parámetros
      (errInsert) => { // Callback
        if (errInsert) return res.status(500).json({ mensaje: 'Error al generar el token' }); // Rechazo por caída de disco

        const link = `http://localhost:3000/reset-password/${token}`; // Concatena el hipervínculo físico mágico inyectando el Hash como segmento URL Dinámico

        // Configuración de Transportador SMTP Gmail (Nodemailer Middleware Module)
        const transporter = nodemailer.createTransport({ // Instancia la conexión transaccional
          service: 'gmail', // Target OAuth/BasicAuth G Suite/Google Mail Service Cloud Provider
          auth: { // Autenticación del sender server backoffice bot origin source account
            user: process.env.GMAIL_USER, // Credencial Segura Oculta `.env` String
            pass: process.env.GMAIL_PASS, // App Password Autenticado Google Security `.env`
          },
        });

        const mailOptions = { // Objeto estructurado Diccionario de Parametros SendMail Base HTML/Texto
          from: `"ProEvent UAPA" <${process.env.GMAIL_USER}>`, // Máscara spoof de remitente alias
          to: correo, // Target endpoint receptor (Cliente)
          subject: 'Restablecer tu contraseña - ProEvent UAPA', // Título Subject header tag
          text: `Hola,\n\nRecibimos una solicitud para restablecer la contraseña de tu cuenta en ProEvent UAPA.\n\nEnlace de restablecimiento (válido por 1 hora):\n${link}\n\nSi no solicitaste este cambio, ignora este correo.\n\nSistema de Gestión de Eventos – UAPA ProEvent`, // Fallback plaintext puro si cliente correo NO admite HTML Render
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
          `, // Inyección Inline CSS para bypass de Email Clients restrictivos (Gmail/Outlook safe css render engine compliant code structure rules block table formatting hack fix)
        };

        transporter.sendMail(mailOptions, (errMail, info) => { // Disparo real TCP del socket hacia SMTP Servers remotos en red con payload compilado base64 content type multipart
          if (errMail) { // Fracaso de conexión o credenciales erróneas banneadas por google policies o bad TLS Handshake protocol mismatch port 465 587 block
            console.error('❌ Error enviando correo:', errMail.message); // Consola verbose local log failure
            return res.status(500).json({ mensaje: 'Error al enviar el correo. Intente de nuevo.' }); // Avisa fallo
          }
          console.log(`✅ Correo enviado a: ${correo} (ID: ${info.messageId})`); // Rastreo feliz Server Node Terminal log monitor process trace uid ID messageid
          res.json({ mensaje: 'Se ha enviado un enlace a su correo electrónico.' }); // Respuesta final HTTP STATUS 200 al UI solicitante de paciencia para revisión Inbox
        });
      }
    );
  });
});

app.get('/validar-token/:token', (req, res) => { // Endpoint auxiliar silencioso de ping pong. Su función es que la Pantalla GUI Reset password se auto-destruya si el token URL caducó o es falso sin requerir botonazo al montar en RAM component
  const { token } = req.params; // Toma segmento Path Dinamico
  db.query( // Lee la tabla sucia temporal de tokens
    'SELECT correo FROM restablecimiento_token WHERE token = ? AND expiracion > NOW()', // Magia SQL C: Chequea MATCH de string con WHERE y usa función matemática Date de base de datos nativa NOW() para verificar si expiró (Time Travel Logic Validation Engine)
    [token],
    (err, results) => { // Analiza return array length bool
      if (err) return res.status(500).json({ mensaje: 'Error al validar el token' }); // Manejador basico logico error
      if (results.length === 0) { // Si falló (O no existe ese hash inventado hacker, o sí existe pero expiracion < menor que NOW())
        return res.status(400).json({ mensaje: 'Token inválido o expirado' }); // Lanza destello mortal al UI para bloquear y ocultar inputs del formulario de nueva key
      }
      res.json({ mensaje: 'Token válido', correo: results[0].correo }); // Concede Permiso UI Temporal a renderizar Cajas de Texto "Nueva Contraseña x2" y exporta el Mail Subyacente acoplado al hash index
    }
  );
});

app.post('/restablecer-contrasena', (req, res) => { // Endpoint Definitivo Mutador Táctico Finalizador (Post de ejecución destructiva y sobre-escritura)
  const { token, nuevaContrasena } = req.body; // Requiere la llave token devuelta en payload y el plaintext string password recien digitado
  
  // 1. Re-Validar Estrictamente lado servidor node el token antes de matar contraseña antigua (Evita Bypassing REST calls Postman y Replays)
  db.query(
    'SELECT correo FROM restablecimiento_token WHERE token = ? AND expiracion > NOW()', // Mismo chequeo de caducidad temporal anti-latencia
    [token],
    (err, results) => {
      if (err) return res.status(500).json({ mensaje: 'Error al validar el token' }); // Fallo Try Catch like
      if (results.length === 0) { // Timeout confirmacion reaccion tardia usuario o inyeccion delay ataque
        return res.status(400).json({ mensaje: 'Token inválido o expirado' });
      }

      const correo = results[0].correo; // Pinpoint selectivo estricto de la cuenta víctima objetiva a actualizar segun el token

      // 2. Actualizar contraseña oficial (Idealmente aquí se usaría un Bcrypt Hash gen salt, pero ProEvent iteración Mvp usa Plaintext local en db SQL Base table usuario provisorio por ahora para prueba simple académica de flujo login basico)
      db.query(
        'UPDATE usuario SET contrasena = ? WHERE correo = ?', // Exec Update query basico relacional root string modify setter
        [nuevaContrasena, correo],
        (errUpdate) => {
          if (errUpdate) return res.status(500).json({ mensaje: 'Error al actualizar la contraseña' }); // Fallo MySQL Update query parse

          // 3. Destruir e incinerar el token usado para asegurar su condición "Uso Único Desechable Limitado" o (One Time Use - Burn after read single use ticket policy enforcer mechanism destructor)
          db.query('DELETE FROM restablecimiento_token WHERE correo = ?', [correo], () => { }); // Purga silenciada sin catch back alert trigger

          res.json({ mensaje: 'Contraseña actualizada con éxito' }); // Respuesta Ok Verde HTTP 200 Exito UI Router App PWA React Redirect logic flag return
        }
      );
    }
  );
});

// ── EVALUACIONES DE CALIDAD EVENTO POST-MORTEM — CREAR ───────────────────────────────
app.post('/evaluaciones', (req, res) => { // Via POST API graba encuesta final de calidad retroalimentadora del solicitante
  const { id_evento, respuesta_solicitud, recinto, valoracion_respuesta, satisfaccion, comentario } = req.body; // Cosecha respuestas y variables metricas JSON parse destructuradas
  
  // Regla Negocio Fuerte Validatoria de Nulls Protectores (Anti-Blank Form submit prevention)
  if (!id_evento || !respuesta_solicitud || !recinto || !valoracion_respuesta || !satisfaccion) { 
    return res.status(400).json({ mensaje: 'Todos los campos obligatorios deben ser completados.' }); // Bouncer reject fail fast param guard
  }

  // Regla Negocio Lógica Matemática Limitante de fronteras (Threshold constraint estricto min 1 estrella - max 5 estrellas rank)
  if (satisfaccion < 1 || satisfaccion > 5) {
    return res.status(400).json({ mensaje: 'El nivel de satisfacción debe estar entre 1 y 5.' }); // Repulsa hacker attacks override API parameter mutation string
  }

  db.query( // Disparo de acción transaccional de Inserción de Metric Collection data log base
    `INSERT INTO evaluacion (id_evento, respuesta_solicitud, recinto, valoracion_respuesta, satisfaccion, comentario)
     VALUES (?, ?, ?, ?, ?, ?)`, // Transfiere variables paramétricas enmascaradas con placeholders '?' previniendo inyección de consultas SQL 
    [id_evento, respuesta_solicitud, recinto, valoracion_respuesta, satisfaccion, comentario || null], // Matriz condicional array 
    (err, result) => { // Node JS lambda Callback
      if (err) return res.status(500).json({ mensaje: 'Error al registrar la evaluación', error: err.message }); // Fallback control de base de datos error (Fallo en constraint llave foránea si el evento no existe)
      res.status(201).json({ mensaje: 'Evaluación enviada con éxito', id_evaluacion: result.insertId }); // Okey verde HTTP 201 Created Status Devuelve UUID nuevo auto num generado al vuelo en MySQL Server
      const reqUserId = req.headers['x-usuario-id']; // Busca Head Admin ID para historial (Puede ser nulo u opcional dependiendo de quién dispara si es logueado)
      if (reqUserId) registrarMovimiento( // Apunta function call Historial Bitacora Transversal Global
        reqUserId, null, 'CREACION_EVALUACION', // Dispara el evento nomenclado
        `Nueva evaluación registrada. ID: ${result.insertId}. Evento ID: ${id_evento}. Recinto: ${recinto}. Valoración: ${valoracion_respuesta}. Satisfacción: ${satisfaccion}/5.` // Trazo detallado metrico log audit template string con variables concatenadas para rastreo analógico histórico forense.
      );
    }
  );
});

// ── EVALUACIONES — OBTENER TODAS GERENCIAL MASTER STATS ───────────────────────
app.get('/evaluaciones', (req, res) => { // Resumen General de encuestas Extraidas (Soporte ideal PowerBi Data Mining Stats o Dashboard Stats Panel GUI Front)
  db.query( // Inner query con macro join a root evento matriz para sacar el titulo textual semántico relacional
    `SELECT
       ev.id_evaluacion, ev.id_evento, ev.respuesta_solicitud,
       ev.recinto, ev.valoracion_respuesta, ev.satisfaccion,
       ev.comentario, ev.fecha,
       e.nombre AS nombre_evento
     FROM evaluacion ev
     LEFT JOIN evento e ON ev.id_evento = e.id_evento -- Cruza foreign ID number key para leer titulo textual descriptivo de qué evento estamos opinando en forma de texto humano
     ORDER BY ev.fecha DESC`, // Más reciente siempre en el tope LIFO top visual sort engine descendente para que lo nuevo aparezca a simple vista sin scroll
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message }); // Interrupción destructiva controlada DB Outage Error response JSON obj export down error msg string
      res.json(results); // Exporta Data Frame Result Set completo Array listo para tablas y gráficos dashboard rendering react context
    }
  );
});

// ── CATÁLOGOS DINÁMICOS CRUD BÁSICO MANTENEDORES GLOBALES (Settings Generales) ─────────────────────────────────

// 1. Equipos Audiovisuales Abm (Alta Baja Modificacion Diccionario)
app.get('/equipos-audiovisuales', (req, res) => { // Listado API Get route fetch call global index search parameter
  db.query('SELECT * FROM equipo_audiovisual ORDER BY nombre ASC', (err, results) => { // Llama el diccionario total alfanumericamente ordenado natural de letras A-Z ASC Ascending
    if (err) return res.status(500).json({ error: err.message }); // Handle return res status code http
    res.json(results); // Export Result Array Collection List elements
  });
});
app.post('/equipos-audiovisuales', (req, res) => { // Creacion de Item de Catálogo ('Nueva máquina registrada al inventario físico real uapa db')
  const { nombre, icono, cantidad_total } = req.body; // Objeto data prop input elements req format JSON parse
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' }); // Condicion 0 validation rules blank logic guard fail bypass trigger
  db.query('INSERT INTO equipo_audiovisual (nombre, icono, cantidad_total) VALUES (?, ?, ?)', [nombre, icono || 'FiMonitor', cantidad_total || 0], (err, result) => { // Instancia fisicamente con iconos feather react default FiMonitor icon fallback default parameter text string array insert in mysql parameter object array value struct
    if (err) return res.status(500).json({ error: err.message }); // HTTP Exception catcher JSON send out return 
    res.status(201).json({ mensaje: 'Equipo Creado', id: result.insertId }); // Ok 201 Created Inserted id fetch global parameter object ID assign index
  });
});
app.put('/equipos-audiovisuales/:id', (req, res) => { // Edita existencia metadatos update edit modify properties update string metadata name icon icon-pack count de maquinas en diccionario inventario existencias update method parameter query in url express route regex param target
  const { nombre, icono, cantidad_total } = req.body; // Cosechadora req body object param element properties destruct obj js target keys vars constants extract assignment data string array number
  db.query('UPDATE equipo_audiovisual SET nombre=?, icono=?, cantidad_total=? WHERE id_equipo=?', [nombre, icono, cantidad_total || 0, req.params.id], (err) => { // Update estatico param string replacement index target where equals strict math int sql native syntax execute connection string payload transmit variable mapping 
    if (err) return res.status(500).json({ error: err.message }); // error boundary stop execution logic chain return object json content type text
    res.json({ mensaje: 'Equipo Actualizado' }); // Ok 200 return object text 
  });
});
app.delete('/equipos-audiovisuales/:id', (req, res) => { // API Backend server Delete Endpoint Router parameter express method destructure
  db.query('DELETE FROM equipo_audiovisual WHERE id_equipo=?', [req.params.id], (err) => { // Desvanece item fisico dictionary delete wipe erase action function database table action native execution run commit delete math 
    if (err) return res.status(500).json({ error: err.message }); // Falla por FK constraint constraint de evento previo en foreign rules (foreign key constraint error mysql native failure code prevention crash loop block mechanism return code string)
    res.json({ mensaje: 'Equipo Eliminado' }); // Success Result Out JSON body string text response status 200 HTTP API Standard return
  });
});

// 2. Tipos de Evento Master (Catálogo Estático Funcional)
app.get('/tipos-evento', (req, res) => { // Endpoint Listar GET
  db.query('SELECT * FROM tipo_evento_master ORDER BY nombre ASC', (err, results) => { // Query Orden Alfabetico 
    if (err) return res.status(500).json({ error: err.message }); // Escudo Error
    res.json(results); // Export Result List JSON array
  });
});
app.post('/tipos-evento', (req, res) => { // Add new type
  const { nombre } = req.body; // Pide string param input
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' }); // Bouncer vacio
  db.query('INSERT INTO tipo_evento_master (nombre) VALUES (?)', [nombre], (err, result) => { // Insert Table
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ mensaje: 'Tipo Creado', id: result.insertId }); // Exito
  });
});
app.put('/tipos-evento/:id', (req, res) => { // Modificador Metadata
  db.query('UPDATE tipo_evento_master SET nombre=? WHERE id_tipo_evento=?', [req.body.nombre, req.params.id], (err) => { // Update row
    if (err) return res.status(500).json({ error: err.message }); // Error throw handler
    res.json({ mensaje: 'Tipo Actualizado' }); // Success return message string object JSON HTTP 200
  });
});
app.delete('/tipos-evento/:id', (req, res) => { // Borrado duro
  db.query('DELETE FROM tipo_evento_master WHERE id_tipo_evento=?', [req.params.id], (err) => { // Destructor
    if (err) return res.status(500).json({ error: err.message }); // Bloqueo de Foreign Key Restrict si algun evento viejo usa este tipo master 
    res.json({ mensaje: 'Tipo Eliminado' }); // Success 200 OK 
  });
});

// 3. Tipos de Detalle Corporativo (Checkboxes Master list)
app.get('/tipos-detalle-corporativo', (req, res) => { // Ruta listado GET HTTP Endpoint Node API Router
  db.query('SELECT * FROM tipo_detalle_corporativo ORDER BY nombre ASC', (err, results) => { // Llama datos
    if (err) return res.status(500).json({ error: err.message }); // Interrumpt catch error
    res.json(results); // Array obj dump 
  });
});
app.post('/tipos-detalle-corporativo', (req, res) => { // Ruta insercion base
  const { nombre } = req.body; // Text param
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' }); // Regex not null check false bypass prevent
  db.query('INSERT INTO tipo_detalle_corporativo (nombre) VALUES (?)', [nombre], (err, result) => { // SQL Ejecucion
    if (err) return res.status(500).json({ error: err.message }); // Caida DB MySQL Log error string parse
    res.status(201).json({ mensaje: 'Detalle Creado', id: result.insertId }); // Send Object Response
  });
});
app.put('/tipos-detalle-corporativo/:id', (req, res) => { // Alter param row 
  db.query('UPDATE tipo_detalle_corporativo SET nombre=? WHERE id_detalle_corp=?', [req.body.nombre, req.params.id], (err) => { // Update Setter target mapping match
    if (err) return res.status(500).json({ error: err.message }); // Error
    res.json({ mensaje: 'Detalle Actualizado' }); // Return UI msg string
  });
});
app.delete('/tipos-detalle-corporativo/:id', (req, res) => { // Destruction Drop delete node row
  db.query('DELETE FROM tipo_detalle_corporativo WHERE id_detalle_corp=?', [req.params.id], (err) => { // Purga 
    if (err) return res.status(500).json({ error: err.message }); // SQL Restrict prevent crash log text error code mysql backend query
    res.json({ mensaje: 'Detalle Eliminado' }); // Send
  });
});

// 4. Alimentos (Catering Master Dictionary Base)
app.get('/alimentos', (req, res) => { // API List Data GET Fetch Call URL Point Route Express Middleware
  db.query('SELECT * FROM alimento ORDER BY nombre ASC', (err, results) => { // SQL Sort Read array from physical drive Table Base DB Connector Connection Thread Pool Loop Callback lambda
    if (err) return res.status(500).json({ error: err.message }); // Exception 
    res.json(results); // Serializer Output
  });
});
app.post('/alimentos', (req, res) => { // Añade Elemento 
  const { nombre } = req.body; // Pide Data 
  if (!nombre) return res.status(400).json({ mensaje: 'Nombre requerido' }); // Filtra vacios null string undefined 
  db.query('INSERT INTO alimento (nombre) VALUES (?)', [nombre], (err, result) => { // Dispara Query
    if (err) return res.status(500).json({ error: err.message }); // Throw log node app error
    res.status(201).json({ mensaje: 'Alimento Creado', id: result.insertId }); // Good path
  });
});
app.put('/alimentos/:id', (req, res) => { // Edita String texto Metadata 
  db.query('UPDATE alimento SET nombre=? WHERE id_alimento=?', [req.body.nombre, req.params.id], (err) => { // Modifica
    if (err) return res.status(500).json({ error: err.message }); // Handler log text response function 
    res.json({ mensaje: 'Alimento Actualizado' }); // Send back ok status code 200 normal text string object 
  });
});
app.delete('/alimentos/:id', (req, res) => { // Remueve Item fisico de sistema global
  db.query('DELETE FROM alimento WHERE id_alimento=?', [req.params.id], (err) => { // Delete action execute query commit MySQL Storage Engine trigger match target ID PK Primary key filter search row delete math function log transaction node router
    if (err) return res.status(500).json({ error: err.message }); // Evita colapso si un Evento historico ya lo seleccionó previamente y tiene FK Lock table rules constraint trigger abort 
    res.json({ mensaje: 'Alimento Eliminado' }); // Terminado HTTP End response write socket close output message
  });
});

// INSTANCIACIÓN DE SERVIDOR EXPRESS JS AL PUERTO ESPECIFICADO LEYENDO VARIABLES DOTENV Y ARRANCANDO CICLO HOST NODE
app.listen(8080, () => { // Bucle infinito Server Boot Initialization process process.env.PORT || 8080 Start Listen TCP Socket Interface Binding Local Network Address Loopback Loop Listen Loop Cycle
  console.log('🚀 Servidor corriendo en http://localhost:8080'); // Terminal Print Output Message Banner Ready System OK Green Light Go Online Broadcast Network Server JS Master
});