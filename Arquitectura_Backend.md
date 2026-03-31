# Arquitectura y Desarrollo del Backend de ProEvent

Este documento detalla exhaustivamente cómo fue concebido, programado y asegurado el componente de servidor (Backend) del sistema ProEvent.

---

## 1. ¿Cómo desarrollamos el Backend paso a paso?

El backend es el "cerebro" y motor invisible de ProEvent. Para desarrollarlo, seguimos los lineamientos de arquitecturas modernas basadas en micro-servicios y APIs RESTful. 

**Tecnologías Clave Utilizadas:**
*   **Entorno de Ejecución:** Node.js, que nos permite correr JavaScript a una velocidad altísima en el lado del servidor.
*   **Framework Principal:** Express.js (`express`), un marco minimalista que facilita la creación de servidores HTTP robustos para manejar el tráfico web de cientos de usuarios simultáneos.
*   **Gestión de Paquetes:** `npm`, con dependencias estrictas declaradas en el archivo `package.json`.

**Paso a Paso del Desarrollo:**
1.  **Estructuración Base:** Inicializamos el proyecto e instalamos dependencias (`cors`, `express`, `mysql2`, `google-auth-library`).
2.  **Configuración del Servidor:** En `server.js`, levantamos el servidor escuchando en un puerto específico y configuramos los "Middlewares" (interceptores) para que el servidor entienda peticiones en formato JSON (`app.use(express.json())`).
3.  **Lógica Transaccional (Business Logic):** Programamos funciones complejas, como los cruces de disponibilidad de horarios, conversiones de monedas extranjeras mediante la API abierta `er-api.com`, y la conciliación contable del Plan Operativo Anual (POA).
4.  **Tareas en Segundo Plano (Cron Jobs):** Desarrollamos rutinas automatizadas como `autoFinalizarEventos()`, que se ejecuta cada hora revisando eventos que ya caducaron y los marca como "Finalizados" sin intervención humana.

---

## 2. Conexión con la Base de Datos

Para que los datos (usuarios, eventos, evaluaciones) sean persistentes, conectamos Node.js con un motor de base de datos relacional **MySQL**.

**¿Cómo se logró y por qué es tan eficiente?**
En lugar de abrir y cerrar la puerta de la base de datos (una conexión simple) cada vez que un usuario hace una solicitud, utilizamos una arquitectura de **Pool de Conexiones** (`mysql.createPool`) importando la librería `mysql2`.

```javascript
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  database: 'uapa_proevent',
  waitForConnections: true,
  connectionLimit: 10, // Límite de autopreservación
  queueLimit: 0
});
```

> [!NOTE]
> **Ventaja del Pool:** El servidor mantiene un conjunto de "tuberías" (conexiones) constantemente abiertas. Si llegan 50 usuarios a revisar el calendario al mismo tiempo, el servidor recicla dinámicamente estas 10 conexiones simultáneas. Esto impide que la base de datos colapse por saturación de tráfico (sobrecarga de RAM).

Adicionalmente, el sistema realiza comprobaciones automáticas al iniciar (DDL). Garantiza que existan en MySQL tablas vitales como `evaluacion` y `restablecimiento_token`; si alguien las borró por accidente, el backend las vuelve a crear en milisegundos.

---

## 3. ¿Qué son los Endpoints y qué función tienen?

Los endpoints ('puntos finales') son **los canales de comunicación o "puertas de servicio"** por los cuales la interfaz del usuario (React) puede hablar con la base de datos. Funcionan como ventanillas de un banco, donde cada ventanilla tiene un propósito único.

**Tipos de Endpoints (Verbos HTTP) en el sistema:**
*   **GET (Consultar):** Se usa para pedir información. 
    * *Ejemplo:* `app.get('/eventos')` extrae de la BD todos los eventos con todas sus uniones relacionales (alimentos, observaciones, recintos) en un gran árbol JSON y se los da a la interfaz para que dibuje el listado.
*   **POST (Crear):** Se usa para insertar información nueva. 
    * *Ejemplo:* `app.post('/eventos')` recibe el formulario y graba un evento, realizando recortes matemáticos dinámicos a los fondos del POA e insertando los servicios audiovisuales a la vez.
*   **PUT (Actualizar):** Modifica registros existentes.
    * *Ejemplo:* `app.put('/poa/movimiento/:id/estado')` actualiza si una solicitud contable fue `Aprobada` o `Rechazada` por los gestores financieros.
*   **DELETE (Eliminar):** Borra permanentemente.
    * *Ejemplo:* `app.delete('/usuarios/:id')`.

Cada vez que das clic en un botón "Guardar" o "Solicitar" en el frontend, en realidad estás llamando de fondo a uno de estos endpoints mágicos que gatillan toda la lógica en el servidor.

---

## 4. Medidas de Seguridad Implementadas

Un sistema institucional como ProEvent requiere seguridad de alto nivel empresarial. El backend está blindado por múltiples capas:

### I. Prevención absoluta contra Inyección SQL (SQLi)
Toda consulta o inserción a la base de datos está paramétrizada utilizando la sintaxis de "placeholders" (`?`). 
```javascript
// La forma INSEGURA (hackeable):
db.query("SELECT * FROM usuario WHERE correo = '" + correo + "'");

// La forma SEGURA usada en nuestro sistema:
db.query("SELECT * FROM usuario WHERE correo = ?", [correo]);
```
Esto garantiza que si un hácker intenta escribir un comando destructivo en el campo de "correo" (ej. `'; DROP TABLE usuario;--`), el gestor `mysql2` purificará el texto y lo tratará única y exclusivamente como un String inofensivo, abortando el hackeo automático.

### II. Autenticación Delegada (Google OAuth 2.0)
El endpoint `/login-google` utiliza la librería certificada `@google/auth-library`. Cuando un empleado inicia sesión con su correo UAPA, el backend nuestro recibe un criptograma y lo reenvía a los servidores de Google para validar su legitimidad criptográfica mediante la variable `GOOGLE_CLIENT_ID`. 
> [!IMPORTANT]
> Nunca manipulamos ni requerimos almacenar contraseñas directas para empleados institucionales, eliminando la responsabilidad local de hackeo masivo de credenciales.

### III. Escudo Perimetral de Acceso Orientado a Orígenes (CORS)
Habilitar `app.use(cors())` activa la normativa *Cross-Origin Resource Sharing*. Esto significa que el navegador impedirá estrictamente que dominios maliciosos o de terceros traten de conectarse o consumir a escondidas nuestra API; solo nuestro Frontend tiene paso libre a interactuar con los datos.

### IV. Trazabilidad Imborrable de Auditoría (Logs Transaccionales)
Incorporamos una función central de vigilancia sistémica llamada **`registrarMovimiento()`**.
Cada acción destructiva, modificadora o creadora en el sistema (aprobar un evento, descontar fondos, crear o borrar a otro usuario) es interceptada. Esta función lee en secreto el Header HTTP `x-usuario-id` forzado en las peticiones y archiva en la tabla `bitacora_movimiento` la fecha, hora, rol corporativo, nombre y qué fue exactamente lo que hizo esa persona en español entendible.
Si ocurre mala praxis, el administrador general tiene un historial inequívoco e irrevocable de lo sucedido. 

### V. Transaccionalidad de Estado Financiero (Rollbacks Dinámicos)
Garantiza integridad monetaria en el POA. Si se le "Rechaza" a un solicitante su petición de presupuesto, el backend matemáticamente intercepta el estado y hace el *"Reintegro/Deducción Direccional"* automático a las cuentas base. Nadie de finanzas tiene que hacerlo a mano; el sistema bloquea, devuelve o sustrae montos por sí solo previniendo desfalcos por error humano.
