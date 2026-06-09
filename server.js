const express = require("express");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");
const session = require("express-session");

const app = express();
const PORT = 3456;

const MONGO_URI =
  "mongodb://nxsupport:nxsupport123..@ec2-13-58-73-2.us-east-2.compute.amazonaws.com:27017/nxsupport?retryWrites=true";
const DB_NAME = "nxsupport";

let db;

// ─── Session config ─────────────────────────────────────────────────────────
app.use(session({
  secret: "nxsupport-horas-secret-key-2024",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

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

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static("public"));

// ─── Conexión MongoDB ──────────────────────────────────────────────────────
async function connectDB() {
  const client = new MongoClient(MONGO_URI, {
    readPreference: "secondaryPreferred",
    directConnection: false,
  });
  await client.connect();
  db = client.db(DB_NAME);
  console.log("Conectado a MongoDB (solo lectura)");
}

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

    const user = await db.collection("users").findOne({ email: email.toLowerCase() });
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
    const users = await db
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
    const companiesFromCol = await db
      .collection("companies")
      .find({}, { projection: { name: 1, _id: 0 } })
      .toArray();
    let companies = companiesFromCol.map((c) => c.name);

    // También agregamos empresas reales desde incidents (filtro estricto)
    const incidentCompanies = await db
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

    const comments = await db
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
          hoursByTicket[ticketKey] = {
            ticketNumber: c.ticketNumber,
            title: c.title,
            company: c.company,
            system: c.system,
            status: c.status,
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

    // Tickets sin horas (solo comentarios del usuario en el período)
    const ticketsWorked = Array.from(ticketsMap.values());

    res.json({
      userEmail,
      period: { start: startDate, end: endDate },
      totalHours: Math.round(totalHours * 100) / 100,
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
    const ticket = await db
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

// ─── Inicio ─────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Error al iniciar:", err);
  process.exit(1);
});
