// MyStyle AI — backend server
// API key-г энд бичихгүй. .env файлд ANTHROPIC_API_KEY тавина.

// .env файлыг уншина (Node 20.6+ built-in). Хуучин Node дээр энэ мөрийг
// устгаад `npm i dotenv` хийж `require("dotenv").config()` болгож болно.
try { process.loadEnvFile(); } catch (e) { /* .env байхгүй эсвэл хуучин Node — алгасна */ }

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const auth = require("./lib/auth");
const limits = require("./lib/limits");
const { createStore } = require("./lib/store");
const { buildContent, storableInput } = require("./lib/prompt");

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MYSTYLE_MODEL || "claude-sonnet-4-6";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
// Өнгөний тайлбар, размер нэмэгдсэн тул хариу урт — max_tokens болон хугацааг нэмсэн
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8000;
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 90000;

// $ / 1M token (input, output) — /api/admin/stats дээрх зардлын тооцоонд
const PRICES = {
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-4-5-20251001": [1, 5],
};

const TRACKABLE = new Set(["premium_click", "pdf_click", "again_click", "report_view", "pricing_click"]);

function createApp(store = createStore()) {
  const app = express();
  // Vercel/Render proxy-ийн ард бодит IP-г X-Forwarded-For-оос авна
  app.set("trust proxy", process.env.VERCEL === "1" || process.env.TRUST_PROXY === "1");
  app.use(express.json({ limit: "30mb" })); // selfie + олон хувцасны зураг багтаахаар лимит өндөр
  app.use(express.static(path.join(__dirname, "public")));

  const ipHash = (req) => auth.hashIp(req.ip);
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: "Серверийн алдаа. Дахин оролдоно уу." });
  });

  async function currentUser(req) {
    const id = auth.userIdFromRequest(req);
    return id ? store.getUserById(id) : null;
  }

  async function authThrottle(req, res) {
    const key = `auth:${ipHash(req)}:${limits.hourKey()}`;
    if ((await store.incrUsage(key, 1)) > limits.LIMITS.authPerHour) {
      res.status(429).json({ error: "Хэт олон оролдлого. Түр хүлээгээд дахин оролдоно уу." });
      return false;
    }
    return true;
  }

  function readCredentials(body) {
    const email = String((body && body.email) || "").trim().toLowerCase();
    const password = String((body && body.password) || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: "И-мэйл хаяг буруу байна." };
    if (password.length < 8 || password.length > 200) return { error: "Нууц үг хамгийн багадаа 8 тэмдэгт байна." };
    return { email, password };
  }

  // Нэвтрэхээс өмнө гаргасан тайланг шинэ/нэвтэрсэн хэрэглэгчид холбоно
  async function claim(body, userId) {
    const token = body && typeof body.claimToken === "string" ? body.claimToken : null;
    return token ? store.claimReport(token, userId) : null;
  }

  // ---------- Бүртгэл / нэвтрэлт ----------

  app.post("/api/auth/register", wrap(async (req, res) => {
    if (!(await authThrottle(req, res))) return;
    const c = readCredentials(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    const user = await store.createUser(crypto.randomUUID(), c.email, auth.hashPassword(c.password));
    if (!user) return res.status(409).json({ error: "Энэ и-мэйлээр бүртгэл аль хэдийн байна. Нэвтэрнэ үү." });
    await claim(req.body, user.id);
    await store.logEvent("signup", user.id);
    res.setHeader("Set-Cookie", auth.sessionCookie(user.id));
    res.json({ user: { id: user.id, email: user.email } });
  }));

  app.post("/api/auth/login", wrap(async (req, res) => {
    if (!(await authThrottle(req, res))) return;
    const c = readCredentials(req.body);
    const user = !c.error && (await store.getUserByEmail(c.email));
    if (!user || !auth.verifyPassword(c.password, user.pass_hash)) {
      return res.status(401).json({ error: "И-мэйл эсвэл нууц үг буруу байна." });
    }
    await claim(req.body, user.id);
    await store.logEvent("login", user.id);
    res.setHeader("Set-Cookie", auth.sessionCookie(user.id));
    res.json({ user: { id: user.id, email: user.email } });
  }));

  app.post("/api/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", auth.clearCookie());
    res.json({ ok: true });
  });

  app.get("/api/me", wrap(async (req, res) => {
    const user = await currentUser(req);
    const quota = await limits.remaining(store, { userId: user && user.id, ipHash: ipHash(req) });
    // Өмнөх тестийн хариулт — дахин бөглөхөд урьдчилан бөглөнө
    const lastInput = user ? await store.getLastInput(user.id) : null;
    res.json({ user: user ? { id: user.id, email: user.email } : null, quota, lastInput });
  }));

  // Бүртгэл болон бүх тайланг бүрмөсөн устгах (privacy)
  app.delete("/api/me", wrap(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Нэвтрээгүй байна." });
    await store.deleteUser(user.id);
    res.setHeader("Set-Cookie", auth.clearCookie());
    res.json({ ok: true });
  }));

  // ---------- Хадгалсан тайлангууд ----------

  app.get("/api/reports", wrap(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Нэвтрээгүй байна." });
    res.json({ reports: await store.listReports(user.id) });
  }));

  app.get("/api/reports/:id", wrap(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Нэвтрээгүй байна." });
    const r = await store.getReport(req.params.id, user.id);
    if (!r) return res.status(404).json({ error: "Тайлан олдсонгүй." });
    res.json(r);
  }));

  // ---------- Хэрэглээ хэмжих ----------

  app.post("/api/track", wrap(async (req, res) => {
    const name = req.body && req.body.event;
    if (!TRACKABLE.has(name)) return res.status(400).json({ error: "unknown event" });
    const key = `track:${ipHash(req)}:${limits.hourKey()}`;
    if ((await store.incrUsage(key, 1)) > 100) return res.status(429).json({ ok: false });
    const user = await currentUser(req);
    await store.logEvent(name, user && user.id);
    res.json({ ok: true });
  }));

  app.get("/api/admin/stats", wrap(async (req, res) => {
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const ok = ADMIN_TOKEN && given.length === ADMIN_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_TOKEN));
    if (!ok) return res.status(401).json({ error: "unauthorized" });
    const s = await store.stats(limits.ubDayStartIso());
    const costUsd = s.byModel.reduce((sum, m) => {
      const [pi, po] = PRICES[m.model] || [0, 0];
      return sum + (Number(m.input_tokens) * pi + Number(m.output_tokens) * po) / 1e6;
    }, 0);
    res.json({ ...s, estimatedCostUsd: Math.round(costUsd * 100) / 100, limits: limits.LIMITS, model: MODEL });
  }));

  // ---------- Стилийн тайлан гаргах ----------

  app.post("/api/style", wrap(async (req, res) => {
    if (!API_KEY) {
      return res.status(500).json({ error: "Серверт ANTHROPIC_API_KEY тохируулаагүй байна." });
    }

    const a = req.body || {};
    const user = await currentUser(req);
    const userId = user ? user.id : null;
    const ident = { userId, ipHash: ipHash(req) };
    const { promptText, content, hasImages, hasPhoto, wardrobeCount } = buildContent(a);
    const input = { ...storableInput(a), hasPhoto, wardrobeCount };

    // Ижил хариулттай, зураггүй хүсэлтэд өмнөх тайланг дахин ашиглана — Claude дуудахгүй, хязгаар хасахгүй
    const cacheKey = hasImages ? null : crypto.createHash("sha256").update(MODEL + "\n" + promptText).digest("hex");
    let report = cacheKey ? await store.getCache(cacheKey) : null;
    const cached = !!report;
    let usage = { input_tokens: 0, output_tokens: 0 };

    if (!report) {
      const slot = await limits.reserve(store, limits.reportBuckets(ident));
      if (!slot.ok) {
        const msg = {
          anon: "Өнөөдрийн үнэгүй тайлангаа ашигласан байна. Бүртгүүлбэл сард " + limits.LIMITS.userPerMonth + " тайлан үнэгүй авна.",
          user: "Энэ сарын үнэгүй тайлангийн хязгаар (" + limits.LIMITS.userPerMonth + ") дууссан байна.",
          ip: "Энэ сүлжээнээс өнөөдөр хэт олон тайлан гаргасан байна. Маргааш дахин оролдоно уу.",
          global: "Өнөөдөр хэрэглэгч их байгаа тул түр хязгаарласан. Маргааш дахин оролдоно уу.",
        }[slot.code];
        return res.status(429).json({ error: msg, code: slot.code });
      }

      try {
        const result = await callClaude(content);
        report = result.report;
        usage = result.usage;
      } catch (err) {
        await slot.release();
        console.error(err);
        return res.status(502).json({ error: "AI зөвлөгөө гаргахад алдаа гарлаа." });
      }
      if (cacheKey) await store.setCache(cacheKey, report);
    }

    const id = crypto.randomUUID();
    const claimToken = userId ? null : crypto.randomBytes(18).toString("base64url");
    await store.saveReport({
      id, userId, claimToken, input, report, model: MODEL, cached,
      inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
    });
    console.log(JSON.stringify({ evt: "report", id, user: !!userId, cached, ...usage }));

    const quota = await limits.remaining(store, ident);
    res.json({ report, id, saved: !!userId, claimToken, quota });
  }));

  return app;
}

async function callClaude(content) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: "user", content }] }),
    });
    const data = await r.json();
    if (data.error) throw new Error("Anthropic error: " + JSON.stringify(data.error));
    if (data.stop_reason === "max_tokens") throw new Error("Хариу max_tokens-д хүрч тасарсан: " + JSON.stringify(data.usage));

    let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s >= 0 && e >= 0) text = text.slice(s, e + 1);

    return { report: JSON.parse(text), usage: data.usage || {} };
  } finally {
    clearTimeout(timeout);
  }
}

const app = createApp();

if (process.env.VERCEL !== "1" && require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`MyStyle сервер аслаа: http://localhost:${PORT}`));
}

module.exports = app;
module.exports.createApp = createApp;
