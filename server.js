const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = 3000;

// ----- Config -----
const DB_PATH = path.join(__dirname, "db.json");
const API_KEY = "09f443ae647258a69c856b58371234e2"; // OpenWeatherMap key

// ----- Middleware -----
app.use(express.json());

// ----- In-Memory Weather Cache -----
const weatherCache = new Map();

// ----- Utility: Read/Write DB -----
function readDB() {
  if (!fs.existsSync(DB_PATH)) return { events: [] };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) || { events: [] };
  } catch {
    return { events: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ----- Utility: Simplify Weather Data -----
function simplifyWeather(raw) {
  return {
    temp: raw.main?.temp || 0,
    description: raw.weather?.[0]?.description || "unknown",
    wind: raw.wind?.speed || 0,
    clouds: raw.clouds?.all ?? null,
    icon: raw.weather?.[0]?.icon || "",
  };
}

// ----- Utility: Suitability Scoring -----
function getSuitability(weather, type) {
  if (!weather) return { score: 0, suitability: "Unknown" };

  let score = 50;
  const desc = weather.description.toLowerCase();

  if (desc.includes("clear")) score += 30;
  if (desc.includes("cloud")) score += 10;
  if (desc.includes("rain")) score -= 30;

  if (weather.wind > 10) score -= 10;
  if (weather.temp < 283 || weather.temp > 303) score -= 10;

  if (type === "wedding") score += 10;
  else if (type === "sports") score -= 5;

  score = Math.max(0, Math.min(100, score));
  const suitability = score > 80 ? "Great" : score > 60 ? "Good" : score > 40 ? "Okay" : "Poor";

  return { score, suitability };
}

// ----- Utility: Fetch with Cache + Error Handling -----
async function getWeather(city, date) {
  const key = `${city}-${date}`;
  if (weatherCache.has(key)) return weatherCache.get(key);

  const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    weatherCache.set(key, data);
    return data;
  } catch (err) {
    console.error(`Weather fetch failed: ${err.message}`);
    throw err;
  }
}

async function safeGetWeather(city, date) {
  try {
    return await getWeather(city, date);
  } catch {
    return null;
  }
}

// ----- Utility: Format Event Output -----
function formatEvent(event) {
  const { id, name, city, date, type, score, suitability, weather } = event;
  return { id, name, city, date, type, score, suitability, weather };
}

// ----- API Routes -----

// POST /events - Create a new event
app.post("/events", async (req, res) => {
  const { name, city, date, type } = req.body;
  const db = readDB();

  const rawWeather = await safeGetWeather(city, date);
  const simplifiedWeather = rawWeather ? simplifyWeather(rawWeather) : null;
  const { score, suitability } = getSuitability(simplifiedWeather, type);

  const newEvent = {
    id: db.events.length + 1,
    name,
    city,
    date,
    type,
    score,
    suitability,
    weather: simplifiedWeather,
  };

  db.events.push(newEvent);
  writeDB(db);
  res.json(formatEvent(newEvent));
});

// GET /events - List all events
app.get("/events", (req, res) => {
  const db = readDB();
  res.json(db.events.map(formatEvent));
});

// PUT /events/:id - Update event details
app.put("/events/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const event = db.events.find(e => e.id === id);
  if (!event) return res.status(404).json({ error: "Event not found" });

  Object.assign(event, req.body);
  writeDB(db);
  res.json(formatEvent(event));
});

// GET /weather/:city/:date - Get raw weather data
app.get("/weather/:city/:date", async (req, res) => {
  const { city, date } = req.params;
  const weather = await safeGetWeather(city, date);
  if (!weather) return res.status(500).json({ error: "Weather API unavailable or invalid location" });
  res.json(weather);
});

// POST /events/:id/weather-check - Refresh weather & suitability
app.post("/events/:id/weather-check", async (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const event = db.events.find(e => e.id === id);
  if (!event) return res.status(404).json({ error: "Event not found" });

  const rawWeather = await safeGetWeather(event.city, event.date);
  if (!rawWeather) return res.status(500).json({ error: "Weather check failed" });

  const simplified = simplifyWeather(rawWeather);
  const { score, suitability } = getSuitability(simplified, event.type);

  event.weather = simplified;
  event.score = score;
  event.suitability = suitability;
  writeDB(db);
  res.json(formatEvent(event));
});

// GET /events/:id/suitability
app.get("/events/:id/suitability", (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const event = db.events.find(e => e.id === id);
  if (!event) return res.status(404).json({ error: "Event not found" });

  res.json({ score: event.score, suitability: event.suitability });
});

// GET /events/:id/alternatives - Suggest nearby better dates
app.get("/events/:id/alternatives", async (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const event = db.events.find(e => e.id === id);
  if (!event) return res.status(404).json({ error: "Event not found" });

  const baseDate = new Date(event.date);
  const suggestions = [];

  for (let offset = -3; offset <= 3; offset++) {
    if (offset === 0) continue;
    const newDate = new Date(baseDate);
    newDate.setDate(newDate.getDate() + offset);
    const dateStr = newDate.toISOString().split("T")[0];

    const weatherRaw = await safeGetWeather(event.city, dateStr);
    if (!weatherRaw) continue;

    const simplified = simplifyWeather(weatherRaw);
    const { score, suitability } = getSuitability(simplified, event.type);
    suggestions.push({ date: dateStr, score, suitability });
  }

  if (!suggestions.length) {
    return res.status(404).json({ message: "No suitable alternatives found due to weather data unavailability." });
  }

  res.json(suggestions.sort((a, b) => b.score - a.score));
});

// ----- Start Server -----
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
