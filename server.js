const express = require("express");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");
const cookieSession = require("cookie-session");

const app = express();
const PORT = process.env.PORT || 3456;

const MONGO_URI = process.env.MONGO_URI ||
  "mongodb://nxsupport:nxsupport123..@ec2-13-58-73-2.us-east-2.compute.amazonaws.com:27017/nxsupport?retryWrites=true";
const DB_NAME = process.env.DB_NAME || "nxsupport";
const SESSION_SECRET = process.env.SESSION_SECRET || "nxsupport-horas-secret-key-2024";

let db;
let excelPriorityMap = {}; // #XYZ -> prioridad

// ─── Cargar Excel de Elecmetal ──────────────────────────────────────────────
function loadExcel() {
  try {
    const X = require("xlsx");
    const wb = X.readFile(process.env.EXCEL_PATH || "./_Ticket_Elecmental.xlsx");
    const sheet = wb.Sheets["NEOX Elecmetal"];
    if (!sheet) { console.log("Sheet NEOX Elecmetal no encontrada"); return; }
    const data = X.utils.sheet_to_json(sheet, { defval: "" });
    data.forEach((r) => {
      const title = (r["1"] || "").trim();
      const prio = (r["Prioridad "] || "").trim();
      if (title && prio) {
        // Extraer #XYZ del título: "#265 - algo" -> "#265"
        const match = title.match(/#\d+/);
        if (match) {
          excelPriorityMap[match[0]] = prio;
        }
      }
    });
    console.log(`Excel cargado: ${Object.keys(excelPriorityMap).length} tickets con prioridad`);
  } catch (e) {
    console.log("Excel no disponible:", e.message);
  }
}
loadExcel();

// ─── Mapeo de prioridad a color ─────────────────────────────────────────────
const PRIO_MAP = {
  "Crítica": { color: "#e74c3c", level: "alta", order: 0 },
  "Mayor":   { color: "#e74c3c", level: "alta", order: 0 },
  "Media":   { color: "#f1c40f", level: "media", order: 1 },
  "Menor":   { color: "#2ecc71", level: "baja", order: 2 },
};

function getPriorityFromTicket(title) {
  if (!title) return null;
  const m = title.match(/#\d+/);
  if (m && excelPriorityMap[m[0]]) return excelPriorityMap[m[0]];
  return null;
}

// Trust proxy (Vercel termina HTTPS en edge, reenvía HTTP internamente)
app.set("trust proxy", 1);

// ─── Session config (cookie-based, sin estado - ideal para Vercel) ──────────
app.use(cookieSession({
  name: "session",
  secret: SESSION_SECRET,
  maxAge: 8 * 60 * 60 * 1000, // 8 horas
  httpOnly: true,
  sameSite: "lax",
  secure: false, // Vercel maneja HTTPS externamente
}));

// Vercel requiere mantener la conexión MongoDB viva entre requests
let dbPromise = null;
function getDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const client = new MongoClient(MONGO_URI, {
        readPreference: "secondaryPreferred",
      });
      await client.connect();
      db = client.db(DB_NAME);
      console.log("Conectado a MongoDB (solo lectura)");
      return db;
    })();
  }
  return dbPromise;
}

// ─── Regex para extraer horas de texto ──────────────────────────────────────
// Orden de patrones: de más específico a más genérico
const HH_PATTERNS = [
  // "total hh ejecutadas : 5" o "total hh ejecutadas: 1,5"
  {
    re: /total\s*(?:de\s+)?hh?\s*ejecutadas?\s*:?\s*(\d+)[,.]?(\d*)/i,
    group: 1,
  },
  // "horas consumidas: 2"
  { re: /horas?\s+consumidas?\s*:?\s*(\d+)[,.]?(\d*)/i, group: 1 },
  // "Total de horas consumidas en el soporte 3 HH"
  { re: /total\s+de\s+horas\s+consumidas.*?(\d+)\s*hh/i, group: 1 },
  // "La actividad dura 02 hh"
  { re: /la\s+actividad\s+dura\s*(\d+)\s*hh/i, group: 1 },
  // "Duración: 01 HH", "Duración 2 HH"
  { re: /duraci[oó]n\s*:?\s*(\d+)\s*hh/i, group: 1 },
  // "7HH estimadas", "5 HH de resolución"
  {
    re: /(\d+)\s*hh?\s*(?:estimadas?|de\s+trabajo|de\s+resoluci[oó]n|en\s+la\s+creaci[oó]n)/i,
    group: 1,
  },
  // "se agregan 2 HH"
  { re: /(?:se\s+)?agregan?\s*(\d+)\s*hh/i, group: 1 },
  // "3 horas de trabajo"
  { re: /(\d+)[,.]?(\d*)\s*horas?\s+de\s+trabajo/i, group: 1 },
  // "5 Horas en la creación"
  { re: /(\d+)\s*horas?\s+en\s+la/i, group: 1 },
  // "8Horas" (pegado)
  { re: /(\d+)\s*horas?/i, group: 1 },
  // "N HH" al final o como frase independiente (ej: "15 HH", "1 HH", "3 HH")
  { re: /(\d+)\s*hh\b/i, group: 1 },
  // "N Horas" palabra suelta
  { re: /\b(\d+)\s*horas?\b/i, group: 1 },
];

function extractHoursFromMessage(message) {
  if (!message || typeof message !== "string") return null;

  for (const pattern of HH_PATTERNS) {
    const match = message.match(pattern.re);
    if (match) {
      let hours = parseInt(match[1], 10);
      // Si hay decimal (ej: 1,5)
      if (match[2] && match[2].length > 0) {
        hours = parseFloat(`${match[1]}.${match[2]}`);
      }
      if (!isNaN(hours) && hours > 0 && hours < 1000) {
        return hours;
      }
    }
  }
  return null;
}

function parseUserEmail(commentaryBy) {
  if (!commentaryBy) return null;
  // Formato: "Nombre Apellido - email@neox.cl" o solo "email@neox.cl"
  const match = commentaryBy.match(
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/,
  );
  return match ? match[1].toLowerCase() : commentaryBy.toLowerCase().trim();
}

// ─── Supabase (REST API) ───────────────────────────────────────────────────
const { createClient } = require("@supabase/supabase-js");

let supabaseClient = null;

function getSupabase() {
  if (!supabaseClient) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    if (SUPABASE_URL && SUPABASE_KEY) {
      supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);
      console.log("Supabase REST client listo");
    }
  }
  return supabaseClient;
}

// Helper para ejecutar SQL vía REST (solo SELECT, INSERT, UPDATE, DELETE)
async function supabaseQuery(sql) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no configurado");
  // Usamos rpc como endpoint genérico para queries
  const { data, error } = await supabase.rpc("exec_sql", { query: sql });
  if (error) {
    // Si exec_sql no existe, hacemos la query directa a la tabla
    throw error;
  }
  return data;
}

// ─── Multer (subida de archivos) ────────────────────────────────────────────
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

// ─── Auth middleware ────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.roles && req.session.user.roles.includes("ADMIN")) {
    return next();
  }
  return res.status(401).json({ error: "No autorizado", login: true });
}

// ─── Auth endpoints ─────────────────────────────────────────────────────────

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña requeridos" });
    }

    const user = await (await getDB()).collection("users").findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    if (!user.roles || !user.roles.includes("ADMIN")) {
      return res.status(403).json({ error: "Sin permisos de administrador", noAdmin: true });
    }

    req.session.user = {
      email: user.email,
      name: user.name,
      company: user.company,
      roles: user.roles,
    };

    res.json({
      ok: true,
      user: { name: user.name, email: user.email, roles: user.roles },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// Verificar sesión
app.get("/api/session", (req, res) => {
  if (req.session && req.session.user) {
    return res.json({
      authenticated: true,
      user: req.session.user,
    });
  }
  res.json({ authenticated: false });
});

// ─── API endpoints (protegidos) ──────────────────────────────────────────────

// 1. Lista de usuarios (con nombre y email)
app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const users = await (await getDB())
      .collection("users")
      .find(
        {},
        {
          projection: {
            name: 1,
            email: 1,
            company: 1,
            companies: 1,
            roles: 1,
            _id: 0,
          },
        },
      )
      .sort({ name: 1 })
      .toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Lista de empresas
app.get("/api/companies", requireAdmin, async (req, res) => {
  try {
    const companiesFromCol = await (await getDB())
      .collection("companies")
      .find({}, { projection: { name: 1, _id: 0 } })
      .toArray();
    let companies = companiesFromCol.map((c) => c.name);

    // También agregamos empresas reales desde incidents (filtro estricto)
    const incidentCompanies = await (await getDB())
      .collection("incidents")
      .distinct("company");
    const realCompanies = incidentCompanies.filter(
      (c) => /^[a-záéíóúñü]{3,}(\s[a-záéíóúñü]{2,}){0,3}$/i.test(c) && c.length < 40
    );
    companies = [...new Set([...companies, ...realCompanies])].sort();

    res.json(companies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Horas trabajadas (endpoint principal)
app.get("/api/hours", requireAdmin, async (req, res) => {
  try {
    const { user, company, start, end } = req.query;
    if (!user)
      return res
        .status(400)
        .json({ error: "Se requiere el parámetro user (email)" });

    const userEmail = user.toLowerCase();
    const startDate = start ? new Date(start) : new Date("2020-01-01");
    const endDate = end ? new Date(end) : new Date();

    // Filtro base: comentarios del usuario en el rango de fechas
    const matchFilter = {
      "commentaries.createdBy": {
        $regex: userEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      },
      "commentaries.date": { $gte: startDate, $lte: endDate },
    };
    if (company && company !== "todas") {
      matchFilter.company = company;
    }

    const pipeline = [
      { $match: company && company !== "todas" ? { company } : {} },
      { $unwind: "$commentaries" },
      {
        $match: {
          "commentaries.createdBy": {
            $regex: userEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            $options: "i",
          },
          "commentaries.date": { $gte: startDate, $lte: endDate },
        },
      },
      {
        $project: {
          ticketNumber: 1,
          title: 1,
          company: 1,
          system: 1,
          status: 1,
          date: 1,
          commentMessage: "$commentaries.message",
          commentDate: "$commentaries.date",
          commentBy: "$commentaries.createdBy",
          commentHH: "$commentaries.hh",
        },
      },
      { $sort: { commentDate: 1 } },
    ];

    const comments = await (await getDB())
      .collection("incidents")
      .aggregate(pipeline)
      .toArray();

    // Procesar comentarios: extraer horas (primero del campo hh, luego por regex)
    const ticketsMap = new Map();
    let totalHours = 0;
    let hoursByCompany = {};
    let hoursByDay = {};
    let hoursByTicket = {};

    for (const c of comments) {
      // Usar campo hh (en minutos) si existe, sino intentar extraer del mensaje
      let hours = null;
      let rawHH = null;
      if (c.commentHH !== undefined && c.commentHH !== null) {
        rawHH = parseFloat(c.commentHH);
        // hh está en minutos: convertir a horas (60 = 1h, 120 = 2h, etc.)
        if (!isNaN(rawHH) && rawHH > 0) {
          hours = rawHH / 60;
          if (hours > 24) hours = null; // Max 24h por comentario
        }
      }
      if (hours === null) {
        hours = extractHoursFromMessage(c.commentMessage);
      }
      if (hours !== null) {
        totalHours += hours;

        // Por empresa
        hoursByCompany[c.company] = (hoursByCompany[c.company] || 0) + hours;

        // Por día
        const dayKey = c.commentDate.toISOString().slice(0, 10);
        hoursByDay[dayKey] = (hoursByDay[dayKey] || 0) + hours;

        // Por ticket
        const ticketKey = c.ticketNumber;
        if (!hoursByTicket[ticketKey]) {
          const prio = getPriorityFromTicket(c.title);
          const prioInfo = PRIO_MAP[prio] || { color: "#95a5a6", level: "sin prioridad", order: 3 };
          hoursByTicket[ticketKey] = {
            ticketNumber: c.ticketNumber,
            title: c.title,
            company: c.company,
            system: c.system,
            status: c.status,
            priority: prio || "sin prioridad",
            priorityLevel: prioInfo.level,
            priorityColor: prioInfo.color,
            totalHours: 0,
            comments: [],
          };
        }
        hoursByTicket[ticketKey].totalHours += hours;
        hoursByTicket[ticketKey].comments.push({
          date: c.commentDate,
          message: c.commentMessage.substring(0, 200),
          hours: hours,
        });
      }

      // Registrar ticket aunque no tenga horas extraídas
      if (!ticketsMap.has(c.ticketNumber)) {
        ticketsMap.set(c.ticketNumber, {
          ticketNumber: c.ticketNumber,
          title: c.title,
          company: c.company,
          system: c.system,
          status: c.status,
        });
      }
    }

    // Calcular horas por prioridad
    const hoursByPriority = {};
    Object.values(hoursByTicket).forEach(t => {
      const level = t.priorityLevel || "sin prioridad";
      hoursByPriority[level] = (hoursByPriority[level] || 0) + t.totalHours;
    });
    const priorityLabels = { alta: "Alta", media: "Media", baja: "Baja", "sin prioridad": "Sin prioridad" };
    const priorityColors = { alta: "#e74c3c", media: "#f1c40f", baja: "#2ecc71", "sin prioridad": "#95a5a6" };

    const hoursByPriorityArr = Object.entries(hoursByPriority)
      .map(([level, hrs]) => ({
        level,
        label: priorityLabels[level] || level,
        hours: Math.round(hrs * 100) / 100,
        color: priorityColors[level] || "#95a5a6",
      }))
      .sort((a, b) => {
        const order = { alta: 0, media: 1, baja: 2, "sin prioridad": 3 };
        return (order[a.level] || 99) - (order[b.level] || 99);
      });

    // Tickets sin horas (solo comentarios del usuario en el período)
    const ticketsWorked = Array.from(ticketsMap.values());

    res.json({
      userEmail,
      period: { start: startDate, end: endDate },
      totalHours: Math.round(totalHours * 100) / 100,
      hoursByPriority: hoursByPriorityArr,
      hoursByCompany: Object.entries(hoursByCompany)
        .map(([name, hrs]) => ({
          company: name,
          hours: Math.round(hrs * 100) / 100,
        }))
        .sort((a, b) => b.hours - a.hours),
      hoursByDay: Object.entries(hoursByDay)
        .map(([day, hrs]) => ({
          date: day,
          hours: Math.round(hrs * 100) / 100,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      hoursByTicket: Object.values(hoursByTicket).sort(
        (a, b) => b.totalHours - a.totalHours,
      ),
      ticketsWorked: ticketsWorked.length,
      ticketsWithHours: Object.keys(hoursByTicket).length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Detalle de horas de un ticket específico
app.get("/api/ticket/:ticketNumber", requireAdmin, async (req, res) => {
  try {
    const ticket = await (await getDB())
      .collection("incidents")
      .findOne({ ticketNumber: req.params.ticketNumber });

    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    // Extraer horas de cada comentario (campo hh en minutos + regex)
    const commentsWithHours = ticket.commentaries.map((c) => {
      let hours = null;
      if (c.hh !== undefined && c.hh !== null) {
        const raw = parseFloat(c.hh);
        // hh está en minutos: 60 = 1h, 120 = 2h, etc.
        if (!isNaN(raw) && raw > 0) {
          hours = Math.round((raw / 60) * 100) / 100;
          if (hours > 24) hours = null;
        }
      }
      if (hours === null) {
        hours = extractHoursFromMessage(c.message);
      }
      return {
        date: c.date,
        createdBy: c.createdBy,
        message: c.message,
        hours: hours,
        hh: c.hh !== undefined ? c.hh : null,
        hasFile: c.fileId && c.fileId !== "null",
        fileName: c.fileName && c.fileName !== "null" ? c.fileName : null,
      };
    });

    res.json({
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      company: ticket.company,
      system: ticket.system,
      status: ticket.status,
      assignedTo: ticket.assignedTo,
      reportedBy: ticket.reportedBy,
      date: ticket.date,
      incidentDate: ticket.incidentDate,
      tag: ticket.tag,
      message: ticket.message,
      statusChanges: ticket.statusChanges,
      comments: commentsWithHours,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── Endpoints para Excel Elecmental (Supabase) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// 1. Estado de la conexión y datos
app.get("/api/excel/status", requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.json({ connected: false, message: "Supabase no configurado" });

    const { data, error, count } = await supabase
      .from("tickets_elecmetal")
      .select("*", { count: "exact", head: true });

    if (error && error.code === "PGRST116") {
      return res.json({ connected: true, total: 0, message: "Tabla no creada aún" });
    }

    res.json({ connected: true, total: count || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Subir Excel y sincronizar con Supabase
app.post("/api/excel/upload", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(400).json({ error: "Supabase no configurado" });

    const X = require("xlsx");
    const wb = X.read(req.file.buffer, { type: "buffer" });
    const sheet = wb.Sheets["NEOX Elecmetal"];
    if (!sheet) return res.status(400).json({ error: "Hoja 'NEOX Elecmetal' no encontrada" });

    const data = X.utils.sheet_to_json(sheet, { defval: null, header: 1 });
    if (data.length < 2) return res.status(400).json({ error: "Excel vacío" });

    const headers = data[0];
    const rows = data.slice(1);
    let insertados = 0;
    let actualizados = 0;

    for (const row of rows) {
      const title = (row[0] || "").toString().trim();
      if (!title) continue;
      const ticketRef = title.match(/#\d+/)?.[0] || null;
      if (!ticketRef) continue;

      const horasDiarias = {};
      for (let i = 12; i < headers.length; i++) {
        const h = headers[i];
        if (h && !h.toString().startsWith("__EMPTY") && row[i] !== null && row[i] !== "") {
          const val = parseFloat(row[i]);
          if (!isNaN(val) && val > 0) horasDiarias[h.toString().trim()] = val;
        }
      }

      const record = {
        ticket_ref: ticketRef,
        title,
        estado: row[4] || null,
        a_cargo_de: row[5] || null,
        prioridad: row[6] || null,
        tipo: row[7] || null,
        horas_estimadas: parseFloat(row[8]) || null,
        horas_reales: parseFloat(row[9]) || null,
        vb_george: row[10] || null,
        se_aplica_en: row[11] || null,
        horas_diarias: horasDiarias,
        avance: parseFloat(row[row.length - 3]) || null,
        responsable_validacion: row[row.length - 2] || null,
        avance_semana_anterior: parseFloat(row[row.length - 1]) || null,
      };
      if (row[1]) try { record.fecha_creacion = new Date(row[1]).toISOString(); } catch (e) {}
      if (row[2]) try { record.cambio_estado = new Date(row[2]).toISOString(); } catch (e) {}
      if (row[3] !== null && row[3] !== "") record.dias = parseInt(row[3]) || null;

      // Upsert via REST
      const { data: existing } = await supabase
        .from("tickets_elecmetal")
        .select("id")
        .eq("ticket_ref", ticketRef)
        .maybeSingle();

      if (existing) {
        await supabase.from("tickets_elecmetal").update(record).eq("ticket_ref", ticketRef);
        actualizados++;
      } else {
        await supabase.from("tickets_elecmetal").insert(record);
        insertados++;
      }
    }

    res.json({ ok: true, insertados, actualizados, total_filas: rows.filter(r => (r[0] || "").toString().trim()).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Análisis: comparación estimación vs real
app.get("/api/excel/analisis", requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.json({ error: "Supabase no configurado" });

    // Obtener todos los tickets con estimación
    const { data: tickets, error } = await supabase
      .from("tickets_elecmetal")
      .select("*")
      .not("horas_estimadas", "is", null)
      .gt("horas_estimadas", 0)
      .order("horas_estimadas", { ascending: false });

    if (error) throw error;

    // Procesar en JS (en vez de SQL aggregates, por REST)
    const comparacion = tickets.map(t => ({
      ticket_ref: t.ticket_ref,
      title: t.title,
      a_cargo_de: t.a_cargo_de,
      estado: t.estado,
      prioridad: t.prioridad,
      horas_estimadas: t.horas_estimadas,
      horas_reales: t.horas_reales,
      desviacion_pct: t.horas_estimadas > 0 && t.horas_reales !== null
        ? Math.round(((t.horas_estimadas - t.horas_reales) / t.horas_estimadas) * 100 * 10) / 10
        : null,
      categoria: t.horas_estimadas > 0 && t.horas_reales !== null
        ? (t.horas_reales <= t.horas_estimadas ? "dentro" : "excedido")
        : "sin_datos",
    }));

    const totalConEst = tickets.length;
    const conReales = tickets.filter(t => t.horas_reales !== null);
    const dentro = conReales.filter(t => t.horas_reales <= t.horas_estimadas);
    const excedido = conReales.filter(t => t.horas_reales > t.horas_estimadas);

    const resumen = {
      total_con_estimacion: totalConEst,
      total_con_reales: conReales.length,
      dentro_estimacion: dentro.length,
      excedido: excedido.length,
      promedio_horas_reales: conReales.length ? Math.round(conReales.reduce((s, t) => s + t.horas_reales, 0) / conReales.length * 10) / 10 : 0,
      promedio_horas_estimadas: Math.round(tickets.reduce((s, t) => s + t.horas_estimadas, 0) / tickets.length * 10) / 10,
    };

    // Por estado
    const estadoMap = {};
    tickets.forEach(t => {
      const e = t.estado || "Sin estado";
      if (!estadoMap[e]) estadoMap[e] = { count: 0, totalHH: 0 };
      estadoMap[e].count++;
      if (t.horas_reales !== null) estadoMap[e].totalHH += t.horas_reales;
    });
    const por_estado = Object.entries(estadoMap).map(([estado, v]) => ({
      estado,
      cantidad: v.count,
      promedio_horas: v.count > 0 ? Math.round(v.totalHH / v.count * 10) / 10 : 0,
    })).sort((a, b) => b.cantidad - a.cantidad);

    // Tickets con cambio de estado más antiguo
    const { data: antiguos } = await supabase
      .from("tickets_elecmetal")
      .select("ticket_ref, title, estado, a_cargo_de, cambio_estado, dias")
      .not("cambio_estado", "is", null)
      .order("cambio_estado", { ascending: true })
      .limit(50);

    const tickets_antiguos = (antiguos || []).map(t => ({
      ...t,
      nivel_alerta: t.dias >= 90 ? "critico" : t.dias >= 30 ? "alerta" : t.dias >= 7 ? "atencion" : "normal",
    }));

    res.json({ comparacion, resumen, por_estado, tickets_antiguos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Setup: crear tabla si no existe ───────────────────────────────────────
app.get("/api/setup", requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.json({ ok: false, message: "Supabase no configurado" });

    // Intentar leer la tabla para ver si existe
    const { error } = await supabase.from("tickets_elecmetal").select("id", { count: "exact", head: true });

    if (error && error.code === "PGRST116") {
      // Tabla no existe - dar instrucciones al usuario
      return res.json({
        ok: false,
        message: "La tabla 'tickets_elecmetal' no existe.",
        sql: `
CREATE TABLE tickets_elecmetal (
  id SERIAL PRIMARY KEY,
  ticket_ref VARCHAR(50),
  title TEXT,
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
  horas_diarias JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_elecmetal_estado ON tickets_elecmetal(estado);
CREATE INDEX IF NOT EXISTS idx_tickets_elecmetal_a_cargo ON tickets_elecmetal(a_cargo_de);
CREATE INDEX IF NOT EXISTS idx_tickets_elecmetal_ref ON tickets_elecmetal(ticket_ref);
        `.trim(),
        instrucciones: "Ve a Supabase > SQL Editor > New Query, pega este SQL y ejecútalo.",
      });
    }

    res.json({ ok: true, message: "Tabla tickets_elecmetal existe" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Inicio local ──────────────────────────────────────────────────────────
if (process.env.VERCEL !== "1") {
  (async () => {
    try {
      await getDB();
      app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
      });
    } catch (err) {
      console.error("Error al iniciar:", err);
      process.exit(1);
    }
  })();
}

// Export para Vercel serverless
module.exports = app;
