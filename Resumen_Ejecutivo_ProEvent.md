# Resumen Ejecutivo: Proyecto ProEvent

## 1. Módulo de Presupuesto (POA)
Sistema automatizado de control financiero con las siguientes características:
- **Validación Estricta**: Control de fechas fiscales y horario laboral (8 AM - 6 PM).
- **Multimoneda**: Conversión automática de USD/EUR a DOP vía API en tiempo real.
- **Flujo de Fondos**: Deducción automática al solicitar y reembolso íntegro al rechazar una solicitud (Motivo obligatorio).

## 2. Retos Técnicos (Backend)
- **Consistencia de Datos**: Garantizar que el balance del presupuesto sea exacto tras múltiples ediciones o rechazos.
- **Automatización**: Implementación de una tarea programada para la finalización automática de eventos basada en la fecha.
- **Seguridad**: Restricción de acceso a datos financieros sensible mediante roles (V-A-F).

## 3. Aprendizajes y Pruebas
- **Auditoría**: La bitácora de movimientos es esencial para la transparencia y depuración.
- **Defensa**: Las validaciones en backend son críticas para la estabilidad del sistema.
- **Casos de Éxito**: Las pruebas confirmaron que las deducciones, conversiones y reembolsos operan correctamente sin errores manuales.

## 4. Mejoras Futuras
- **Alertas Externas**: Notificaciones por Correo y Push.
- **Sincronización**: Integración con Calendarios (Google/Outlook).
- **Gestión Avanzada**: Repositorio de facturas (evidencias) y control de inventario de equipos.
