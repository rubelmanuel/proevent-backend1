# Informe Técnico: Módulo de Gestión de Presupuesto (POA) - ProEvent

## 1. Introducción
El módulo de Presupuesto o Plan Operativo Anual (POA) es el componente financiero central del sistema ProEvent. Su objetivo es garantizar que cada solicitud de evento cuente con los fondos necesarios antes de ser procesada, automatizando la conversión de divisas y el control de gastos.

---

## 2. Reglas de Validación y Captura
Para asegurar la integridad de los datos financieros, el sistema implementa múltiples capas de validación en el formulario de solicitud:

### A. Validación Cronológica y Fiscal
- **Año Fiscal**: El sistema prohíbe seleccionar fechas fuera del año fiscal activo configurado por el Administrador V-A-F. 
- **Restricción de Pasado**: No se permite la creación de eventos en años fiscales ya cerrados o fechas pasadas.
- **Horario Laboral**: Las solicitudes deben programarse dentro del horario de oficina (8:00 AM - 6:00 PM) para asegurar la disponibilidad de recursos humanos y técnicos.

### B. Gestión de Divisas (Soporte Multimoneda)
El sistema permite solicitar fondos en **DOP, USD y EUR**.
- **Integración con API**: Se utiliza `ExchangeRate-API` para obtener la tasa de cambio en tiempo real.
- **Conversión Automática**: Todas las solicitudes en moneda extranjera se convierten a Pesos Dominicanos (DOP) para su deducción uniforme de la bolsa del POA.

---

## 3. Flujo de Aprobación y Control de Fondos
El ciclo de vida del presupuesto sigue un modelo estricto de "Deducción-Reembolso":

1.  **Deducción Preventiva**: Al momento de enviar la solicitud, el sistema resta el monto total del "Fondo Disponible" del POA y lo marca como **"Pendiente"**.
2.  **Revisión del Administrador V-A-F**:
    -   **Aprobación**: El fondo se sella definitivamente para el evento.
    -   **Rechazo (Reembolso)**: Si el administrador rechaza la solicitud (requiriendo un motivo obligatorio), el sistema devuelve automáticamente el monto íntegro al Fondo Disponible, restaurando la liquidez del presupuesto institucional.
3.  **Estado POA**: El solicitante puede visualizar en su historial si su presupuesto está "Aprobado", "Rechazado" o aún "Pendiente" por el departamento financiero.

---

## 4. Seguridad y Auditoría (Bitácora)
Cada movimiento relacionado con el presupuesto queda registrado en la tabla `bitacora_movimiento`. El registro incluye:
- **Usuario e ID**: Quién realizó la acción.
- **Acción**: (Ej: "RECHAZO_PRESUPUESTO", "AUTORIZACION_POA").
- **Detalles**: Incluye el nombre del evento, el ID, el monto afectado y, en caso de rechazo, el motivo proporcionado.

---

## 5. Verificación, Pruebas y Resultados

Para validar la robustez del módulo, se ejecutó un plan de pruebas exhaustivo con los siguientes resultados:

### Caso de Prueba 1: Validación de Reglas de Negocio
- **Acción**: Intentar crear un evento en una fecha fuera del año fiscal o en horario no laborable (ej: 11:00 PM).
- **Resultado Esperado**: El sistema debe bloquear el envío y mostrar un mensaje de error.
- **Resultado Obtenido**: **Exitoso**. El formulario emite alertas instantáneas impidiendo la progresión del registro.

### Caso de Prueba 2: Conversión Dinámica de Divisas
- **Acción**: Solicitar un presupuesto de $100 USD en la solicitud de evento.
- **Resultado Esperado**: El sistema debe consultar la tasa de cambio y deducir el equivalente exacto en DOP del POA.
- **Resultado Obtenido**: **Exitoso**. La integración con `ExchangeRate-API` garantiza que el descuento sea preciso según el mercado actual.

### Caso de Prueba 3: Integridad del Flujo de Reembolso
- **Acción**: Rechazar una solicitud previamente enviada desde el panel del Administrador V-A-F.
- **Resultado Esperado**: El monto restado debe retornar íntegramente al balance del POA y el cambio debe reflejarse en la bitácora.
- **Resultado Obtenido**: **Exitoso**. Los fondos se restauran automáticamente y la bitácora registra el motivo del rechazo.

---

## 6. Conclusión
La implementación de este módulo transforma una gestión manual en un proceso automatizado y seguro. Mediante el uso de validaciones en tiempo real y un sistema de reembolsos automáticos, ProEvent garantiza transparencia total en la ejecución presupuestaria del Plan Operativo Anual.
