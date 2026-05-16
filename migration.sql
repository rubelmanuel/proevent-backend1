-- 1. Modificar evento (tipo_evento -> id_tipo_evento)
ALTER TABLE evento ADD COLUMN id_tipo_evento INT;
UPDATE evento e JOIN tipo_evento_master t ON e.tipo_evento = t.nombre SET e.id_tipo_evento = t.id_tipo_evento;
-- Si hay nulos, establecer un valor por defecto o dejarlos (depende de las reglas de negocio, aquí no forzamos NOT NULL todavía)
ALTER TABLE evento DROP COLUMN tipo_evento;
ALTER TABLE evento ADD CONSTRAINT fk_evento_tipo FOREIGN KEY (id_tipo_evento) REFERENCES tipo_evento_master(id_tipo_evento);

-- 2. Modificar detalle_corporativo (tipo -> id_detalle_corp)
ALTER TABLE detalle_corporativo ADD COLUMN id_detalle_corp INT;
UPDATE detalle_corporativo d JOIN tipo_detalle_corporativo t ON d.tipo = t.nombre SET d.id_detalle_corp = t.id_detalle_corp;
ALTER TABLE detalle_corporativo DROP COLUMN tipo;
ALTER TABLE detalle_corporativo ADD CONSTRAINT fk_detalle_corp FOREIGN KEY (id_detalle_corp) REFERENCES tipo_detalle_corporativo(id_detalle_corp);

-- 3. Modificar evaluacion (recinto -> id_recinto)
ALTER TABLE evaluacion ADD COLUMN id_recinto INT;
-- Nota: En evaluacion, el enum dice 'Cibao Oriental','Nagua','Santo Domingo Oriental','Santiago'
-- En recinto, tenemos 'Sede Santiago', 'Santo Domingo Oriental', 'Sibao Oriental Nagua', etc.
-- Mapeo manual aproximado:
UPDATE evaluacion SET id_recinto = 1 WHERE recinto = 'Santiago';
UPDATE evaluacion SET id_recinto = 2 WHERE recinto = 'Santo Domingo Oriental';
UPDATE evaluacion SET id_recinto = 3 WHERE recinto = 'Nagua' OR recinto = 'Cibao Oriental';
ALTER TABLE evaluacion DROP COLUMN recinto;
ALTER TABLE evaluacion ADD CONSTRAINT fk_evaluacion_recinto FOREIGN KEY (id_recinto) REFERENCES recinto(id_recinto);

-- 4. Modificar restablecimiento_token (correo -> id_usuario)
ALTER TABLE restablecimiento_token ADD COLUMN id_usuario INT;
UPDATE restablecimiento_token r JOIN usuario u ON r.correo = u.correo SET r.id_usuario = u.id_usuario;
ALTER TABLE restablecimiento_token DROP COLUMN correo;
ALTER TABLE restablecimiento_token ADD CONSTRAINT fk_token_usuario FOREIGN KEY (id_usuario) REFERENCES usuario(id_usuario);

-- 5. Modificar servicio_audiovisual (tipo_servicio -> id_equipo)
-- Este es el más difícil porque tiene strings concatenados.
-- Vamos a mapear la primera parte antes del delimitador '|'.
ALTER TABLE servicio_audiovisual ADD COLUMN id_equipo INT;
-- Extraer el nombre base (antes de | o el valor completo si no tiene |)
UPDATE servicio_audiovisual s 
JOIN equipo_audiovisual e ON e.nombre = SUBSTRING_INDEX(s.tipo_servicio, '|', 1) 
SET s.id_equipo = e.id_equipo;
-- Borrar columna vieja
ALTER TABLE servicio_audiovisual DROP COLUMN tipo_servicio;
ALTER TABLE servicio_audiovisual ADD CONSTRAINT fk_servicio_equipo FOREIGN KEY (id_equipo) REFERENCES equipo_audiovisual(id_equipo);
