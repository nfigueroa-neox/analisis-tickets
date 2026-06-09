-- Crear tabla principal de tickets Elecmetal
CREATE TABLE IF NOT EXISTS tickets_elecmetal (
  id SERIAL PRIMARY KEY,
  ticket_ref VARCHAR(50),           -- "#156"
  title TEXT,                        -- Título completo del ticket
  estado VARCHAR(100),
  fecha_creacion DATE,
  cambio_estado TIMESTAMP,
  dias INTEGER,
  a_cargo_de VARCHAR(200),
  prioridad VARCHAR(50),
  tipo VARCHAR(100),
  horas_estimadas NUMERIC(10,2),
  horas_reales NUMERIC(10,2),
  vb_george VARCHAR(200),
  se_aplica_en VARCHAR(200),
  avance NUMERIC(5,2),
  responsable_validacion VARCHAR(200),
  avance_semana_anterior NUMERIC(5,2),
  horas_diarias JSONB DEFAULT '{}',  -- { "2024-01-15": 2.5, "2024-01-16": 3 }
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_tickets_elecmetal_estado ON tickets_elecmetal(estado);
CREATE INDEX IF NOT EXISTS idx_tickets_elecmetal_a_cargo ON tickets_elecmetal(a_cargo_de);
CREATE INDEX IF NOT EXISTS idx_tickets_elecmetal_ref ON tickets_elecmetal(ticket_ref);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para updated_at
DROP TRIGGER IF EXISTS trigger_tickets_elecmetal_updated_at ON tickets_elecmetal;
CREATE TRIGGER trigger_tickets_elecmetal_updated_at
  BEFORE UPDATE ON tickets_elecmetal
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
