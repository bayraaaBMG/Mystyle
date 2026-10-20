// MyStyle AI — backend server
// API key-г энд бичихгүй. .env файлд ANTHROPIC_API_KEY тавина.

// .env файлыг уншина (Node 20.6+ built-in). Хуучин Node дээр энэ мөрийг
// устгаад `npm i dotenv` хийж `require("dotenv").config()` болгож болно.
try { process.loadEnvFile(); } catch (e) { /* .env байхгүй эсвэл хуучин Node — алгасна */ }

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const auth = require("./lib/auth");
const limits = require("./lib/limits");
const { createStoreOrUnavailable } = require("./lib/store");
const { buildContent, storableInput, buildTryonContent, TRYON_VERDICTS } = require("./lib/prompt");

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MYSTYLE_MODEL || "claude-sonnet-4-6";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
// Өнгөний тайлбар, размер нэмэгдсэн тул хариу урт — max_tokens болон хугацааг нэмсэн
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8000;
// Шүүгээний зураг ирвэл хувцас бүрийн үнэлгээ + 7 хоногийн төлөвлөгөө нэмэгдэнэ
const WARDROBE_MAX_TOKENS = Number(process.env.WARDROBE_MAX_TOKENS) || 12000;
const TRYON_MAX_TOKENS = 1500;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_TRYON_B64 = 7 * 1024 * 1024; // ~5MB зураг
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 90000;

// $ / 1M token (input, output) — /api/admin/stats дээрх зардлын тооцоонд
const PRICES = {
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-4-5-20251001": [1, 5],
};

// users.role: SUPER_ADMIN — бүх систем; USER — бусад. Дэлгүүрийн админ эсэхийг store_admins-аас тодорхойлно:
// OWNER — багаа (админуудаа) удирдана + MANAGER-ийн бүх эрх; MANAGER — нийлбэр статистик, нэр/өнгө засна.
// STORE_ADMIN нь API-д буцаах "дор хаяж нэг дэлгүүрийн админ" гэсэн тооцоолсон роль.
const ROLES = { SUPER_ADMIN: "SUPER_ADMIN", STORE_ADMIN: "STORE_ADMIN", USER: "USER" };
const LEVELS = { OWNER: "OWNER", MANAGER: "MANAGER" };
// Эдгээр и-мэйлээр нэвтэрсэн хүн автоматаар SUPER_ADMIN болно (анхны админ үүсгэх арга)
const SUPER_ADMIN_EMAILS = new Set(
  String(process.env.SUPER_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const TRACKABLE = new Set(["premium_click", "pdf_click", "again_click", "report_view", "pricing_click", "app_installed", "demo_open", "install_click"]);

function createApp(store = createStoreOrUnavailable()) {
  const app = express();
  // Vercel/Render proxy-ийн ард бодит IP-г X-Forwarded-For-оос авна
  app.set("trust proxy", process.env.VERCEL === "1" || process.env.TRUST_PROXY === "1");
  app.use(express.json({ limit: "30mb" })); // selfie + олон хувцасны зураг багтаахаар лимит өндөр
  app.use(express.static(path.join(__dirname, "public")));

  const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const BASE_MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "manifest.json"), "utf8"));

  const ipHash = (req) => auth.hashIp(req.ip);
  const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => {
    console.error(err);
    // DATABASE_URL / SESSION_SECRET дутуу — функцийг унагахгүй, ойлгомжтой 503 буцаана
    if (err && err.code === "NOT_CONFIGURED") {
      return res.status(503).json({ error: "Үйлчилгээ түр ажиллахгүй байна (серверийн тохиргоо дутуу).", code: "not_configured" });
    }
    res.status(500).json({ error: "Серверийн алдаа. Дахин оролдоно уу." });
  });

  // Тохиргооны шалгалт (deploy-ийн дараа). Нууц утга буцаахгүй, зөвхөн байгаа эсэх.
  app.get("/api/health", wrap(async (req, res) => {
    let db = false;
    try { await store.getUsage("health"); db = true; } catch (e) { /* алга эсвэл холбогдохгүй */ }
    const ok = db && auth.hasSecret() && !!API_KEY;
    res.status(ok ? 200 : 503).json({ ok, db, sessionSecret: auth.hasSecret(), anthropicKey: !!API_KEY, model: MODEL });
  }));

  async function currentUser(req) {
    const id = auth.userIdFromRequest(req);
    return id ? store.getUserById(id) : null;
  }

  // Дэлгүүрийг X-Store толгойгоос (frontend /s/<slug> хуудаснаас илгээнэ) танина. Идэвхгүй бол null.
  async function currentStore(req) {
    const slug = String(req.headers["x-store"] || "").toLowerCase();
    if (!slug || !SLUG_RE.test(slug)) return null;
    const s = await store.getStoreBySlug(slug);
    return s && s.active ? s : null;
  }


  // SUPER_ADMIN_EMAILS-д байгаа хэрэглэгчийг SUPER_ADMIN болгоно
  async function promoteIfSuper(user) {
    if (SUPER_ADMIN_EMAILS.has(user.email) && user.role !== ROLES.SUPER_ADMIN) {
      await store.setUserRole(user.id, ROLES.SUPER_ADMIN);
    }
  }

  const isSuper = (user) => !!user && user.role === ROLES.SUPER_ADMIN;

  // Хэрэглэгч энэ дэлгүүрт need (MANAGER эсвэл OWNER) түвшний эрхтэй юу. OWNER нь MANAGER-ийн эрхийг багтаана.
  async function canManage(user, storeId, need = LEVELS.MANAGER) {
    if (!user || !storeId) return false;
    if (isSuper(user)) return true;
    const level = await store.getStoreLevel(storeId, user.id);
    return level === LEVELS.OWNER || (level === LEVELS.MANAGER && need === LEVELS.MANAGER);
  }

  // Админ хуудсанд нэвтрэх: SUPER_ADMIN эсвэл дор хаяж нэг дэлгүүрийн OWNER/MANAGER.
  // Буцаах: { user, role, stores } — stores нь дэлгүүрийн админы удирддаг дэлгүүрүүд (level-тэй).
  async function requireAdmin(req, res) {
    const user = await currentUser(req);
    if (!user) { res.status(401).json({ error: "Нэвтрээгүй байна." }); return null; }
    if (isSuper(user)) return { user, role: ROLES.SUPER_ADMIN, stores: [] };
    const stores = await store.listUserStores(user.id);
    if (!stores.length) { res.status(403).json({ error: "Эрх хүрэхгүй байна." }); return null; }
    return { user, role: ROLES.STORE_ADMIN, stores };
  }
  async function requireSuper(req, res) {
    const user = await currentUser(req);
    if (!user) { res.status(401).json({ error: "Нэвтрээгүй байна." }); return null; }
    if (!isSuper(user)) { res.status(403).json({ error: "Эрх хүрэхгүй байна." }); return null; }
    return user;
  }
  // req.params.id дэлгүүрт need түвшний эрх шаардана. Эрхгүй бол 403 (дэлгүүр байгаа эсэхийг задруулахгүй), байхгүй бол 404.
  async function requireStore(req, res, need) {
    const user = await currentUser(req);
    if (!user) { res.status(401).json({ error: "Нэвтрээгүй байна." }); return null; }
    if (!(await canManage(user, req.params.id, need))) { res.status(403).json({ error: "Эрх хүрэхгүй байна." }); return null; }
    const st = await store.getStoreById(req.params.id);
    if (!st) { res.status(404).json({ error: "Дэлгүүр олдсонгүй." }); return null; }
    return { user, st };
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
    await promoteIfSuper(user);
    await store.logEvent("signup", user.id, null, (await currentStore(req) || {}).id);
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
    await promoteIfSuper(user);
    await store.logEvent("login", user.id, null, (await currentStore(req) || {}).id);
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
    const tryonQuota = await limits.tryonRemaining(store, { userId: user && user.id, ipHash: ipHash(req) });
    let role = null;
    if (user) role = isSuper(user) ? ROLES.SUPER_ADMIN : (await store.listUserStores(user.id)).length ? ROLES.STORE_ADMIN : ROLES.USER;
    res.json({ user: user ? { id: user.id, email: user.email, role } : null, quota, tryonQuota, lastInput });
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
    await store.logEvent(name, user && user.id, null, (await currentStore(req) || {}).id);
    res.json({ ok: true });
  }));

  // ---------- Админ ----------

  // storeIds: null — бүх систем; массив — зөвхөн тэдгээр дэлгүүрийн нийлбэр
  async function statsFor(storeIds) {
    const s = await store.stats(limits.ubDayStartIso(), storeIds);
    const costUsd = s.byModel.reduce((sum, m) => {
      const [pi, po] = PRICES[m.model] || [0, 0];
      return sum + (Number(m.input_tokens) * pi + Number(m.output_tokens) * po) / 1e6;
    }, 0);
    return { ...s, estimatedCostUsd: Math.round(costUsd * 100) / 100, limits: limits.LIMITS, model: MODEL };
  }

  // ADMIN_TOKEN (скрипт, curl) → бүх систем. SUPER_ADMIN → бүх систем эсвэл ?store=<id>.
  // Дэлгүүрийн админ → ?store=<id> (өөрийн дэлгүүр) эсвэл өгөхгүй бол өөрийн бүх дэлгүүрийн нийлбэр.
  app.get("/api/admin/stats", wrap(async (req, res) => {
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const tokenOk = ADMIN_TOKEN && given.length === ADMIN_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_TOKEN));
    if (tokenOk) return res.json(await statsFor(null));
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const want = typeof req.query.store === "string" && req.query.store ? req.query.store : null;
    if (ctx.role === ROLES.SUPER_ADMIN) return res.json(await statsFor(want ? [want] : null));
    if (want) {
      if (!ctx.stores.some((s) => s.id === want)) return res.status(403).json({ error: "Эрх хүрэхгүй байна." });
      return res.json(await statsFor([want]));
    }
    res.json(await statsFor(ctx.stores.map((s) => s.id)));
  }));

  app.get("/api/admin/me", wrap(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    res.json({ user: { id: ctx.user.id, email: ctx.user.email, role: ctx.role }, stores: ctx.stores });
  }));

  function readStoreFields(body, { partial }) {
    const b = body || {};
    const f = {};
    if (!partial || b.slug !== undefined) {
      const slug = String(b.slug || "").trim().toLowerCase();
      if (!SLUG_RE.test(slug)) return { error: "Slug зөвхөн латин жижиг үсэг, тоо, зураас (2–40 тэмдэгт)." };
      f.slug = slug;
    }
    if (!partial || b.name !== undefined) {
      const name = String(b.name || "").trim();
      if (!name || name.length > 80) return { error: "Дэлгүүрийн нэр 1–80 тэмдэгт." };
      f.name = name;
    }
    if (b.accent !== undefined && b.accent !== null && b.accent !== "") {
      if (!HEX_RE.test(b.accent)) return { error: "Өнгө #RRGGBB хэлбэртэй байна." };
      f.accent = b.accent;
    }
    if (b.dailyCap !== undefined) {
      const n = b.dailyCap === null || b.dailyCap === "" ? null : Number(b.dailyCap);
      if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= 100000)) return { error: "Өдрийн хязгаар 0–100000 бүхэл тоо." };
      f.dailyCap = n;
    }
    if (b.active !== undefined) f.active = !!b.active;
    return { f };
  }

  app.get("/api/admin/stores", wrap(async (req, res) => {
    if (!(await requireSuper(req, res))) return;
    res.json({ stores: await store.listStores() });
  }));

  app.post("/api/admin/stores", wrap(async (req, res) => {
    if (!(await requireSuper(req, res))) return;
    const { f, error } = readStoreFields(req.body, { partial: false });
    if (error) return res.status(400).json({ error });
    const row = await store.createStoreRow({ id: crypto.randomUUID(), ...f });
    if (!row) return res.status(409).json({ error: "Энэ slug аль хэдийн ашиглагдсан байна." });
    res.json({ store: row });
  }));

  // SUPER_ADMIN бүгдийг; OWNER/MANAGER зөвхөн нэр, өнгийг засна
  app.patch("/api/admin/stores/:id", wrap(async (req, res) => {
    const ok = await requireStore(req, res, LEVELS.MANAGER);
    if (!ok) return;
    const body = { ...(req.body || {}) };
    delete body.slug; // slug-ийг өөрчлөхгүй — холбоосууд эвдэрнэ
    if (!isSuper(ok.user)) { delete body.active; delete body.dailyCap; }
    const { f, error } = readStoreFields(body, { partial: true });
    if (error) return res.status(400).json({ error });
    res.json({ store: await store.updateStore(req.params.id, f) });
  }));

  // ---------- Дэлгүүрийн баг: SUPER_ADMIN эсвэл тухайн дэлгүүрийн OWNER ----------

  app.get("/api/admin/stores/:id/admins", wrap(async (req, res) => {
    if (!(await requireStore(req, res, LEVELS.OWNER))) return;
    res.json({ admins: await store.listStoreAdmins(req.params.id) });
  }));

  // Бүртгэлтэй хэрэглэгчийг админ болгох эсвэл түвшинг нь солих: { email, level: OWNER | MANAGER }
  app.post("/api/admin/stores/:id/admins", wrap(async (req, res) => {
    if (!(await requireStore(req, res, LEVELS.OWNER))) return;
    const level = String((req.body && req.body.level) || LEVELS.MANAGER).toUpperCase();
    if (!LEVELS[level]) return res.status(400).json({ error: "Түвшин OWNER эсвэл MANAGER байна." });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const target = email && (await store.getUserByEmail(email));
    if (!target) return res.status(404).json({ error: "Энэ и-мэйлтэй хэрэглэгч олдсонгүй. Эхлээд апп дээр бүртгүүлэх хэрэгтэй." });
    if (target.role === ROLES.SUPER_ADMIN) return res.status(400).json({ error: "SUPER_ADMIN бүх дэлгүүрт эрхтэй тул нэмэх шаардлагагүй." });
    const current = await store.getStoreLevel(req.params.id, target.id);
    if (current === LEVELS.OWNER && level !== LEVELS.OWNER && (await store.countStoreOwners(req.params.id)) <= 1) {
      return res.status(400).json({ error: "Дэлгүүрт дор хаяж нэг OWNER байх ёстой. Эхлээд өөр OWNER нэмнэ үү." });
    }
    const row = await store.setStoreAdmin(req.params.id, target.id, level);
    res.json({ admin: { id: target.id, email: target.email, level: row.level } });
  }));

  app.delete("/api/admin/stores/:id/admins/:userId", wrap(async (req, res) => {
    if (!(await requireStore(req, res, LEVELS.OWNER))) return;
    const level = await store.getStoreLevel(req.params.id, req.params.userId);
    if (!level) return res.status(404).json({ error: "Энэ дэлгүүрийн админ олдсонгүй." });
    if (level === LEVELS.OWNER && (await store.countStoreOwners(req.params.id)) <= 1) {
      return res.status(400).json({ error: "Сүүлийн OWNER-ийг хасах боломжгүй. Эхлээд өөр OWNER нэмнэ үү." });
    }
    await store.removeStoreAdmin(req.params.id, req.params.userId);
    res.json({ ok: true });
  }));

  // ---------- Дэлгүүрийн хуудас (/s/<slug>) ба PWA ----------

  async function activeStoreBySlug(raw) {
    const slug = String(raw || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return null;
    const st = await store.getStoreBySlug(slug);
    return st && st.active ? st : null;
  }

  app.get("/api/store/:slug", wrap(async (req, res) => {
    const st = await activeStoreBySlug(req.params.slug);
    if (!st) return res.status(404).json({ error: "Дэлгүүр олдсонгүй." });
    res.json({ slug: st.slug, name: st.name, accent: st.accent });
  }));

  app.get("/s/:slug", wrap(async (req, res) => {
    const st = await activeStoreBySlug(req.params.slug);
    if (!st) return res.redirect("/");
    res.type("html").send(INDEX_HTML.replace('href="/manifest.json"', `href="/s/${st.slug}/manifest.json"`));
  }));

  // Дэлгүүр бүр өөрийн нэрээр, өөрийн хуудсаар нээгддэг апп болж суулгагдана
  app.get("/s/:slug/manifest.json", wrap(async (req, res) => {
    const st = await activeStoreBySlug(req.params.slug);
    if (!st) return res.status(404).json({ error: "not found" });
    res.type("application/manifest+json").send(JSON.stringify({
      ...BASE_MANIFEST,
      id: `/s/${st.slug}`,
      name: `${st.name} — MyStyle AI`,
      short_name: st.name.slice(0, 12),
      start_url: `/s/${st.slug}`,
    }));
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
    const shop = await currentStore(req);
    const { promptText, content, hasImages, hasPhoto, wardrobeCount } = buildContent(a);
    const input = { ...storableInput(a), hasPhoto, wardrobeCount };

    // Ижил хариулттай, зураггүй хүсэлтэд өмнөх тайланг дахин ашиглана — Claude дуудахгүй, хязгаар хасахгүй
    const cacheKey = hasImages ? null : crypto.createHash("sha256").update(MODEL + "\n" + promptText).digest("hex");
    let report = cacheKey ? await store.getCache(cacheKey) : null;
    const cached = !!report;
    let usage = { input_tokens: 0, output_tokens: 0 };

    if (!report) {
      const buckets = limits.reportBuckets(ident);
      // Дэлгүүр тус бүрд өдрийн хязгаар тавьж болно (дэлгүүрийн төлбөрийн багцтай уялдуулахад)
      if (shop && shop.daily_cap != null) buckets.push({ key: `store:${shop.id}:${limits.dayKey()}`, limit: shop.daily_cap, code: "store" });
      const slot = await limits.reserve(store, buckets);
      if (!slot.ok) {
        const msg = {
          anon: "Өнөөдрийн үнэгүй тайлангаа ашигласан байна. Бүртгүүлбэл сард " + limits.LIMITS.userPerMonth + " тайлан үнэгүй авна.",
          user: "Энэ сарын үнэгүй тайлангийн хязгаар (" + limits.LIMITS.userPerMonth + ") дууссан байна.",
          ip: "Энэ сүлжээнээс өнөөдөр хэт олон тайлан гаргасан байна. Маргааш дахин оролдоно уу.",
          global: "Өнөөдөр хэрэглэгч их байгаа тул түр хязгаарласан. Маргааш дахин оролдоно уу.",
          store: "Энэ дэлгүүрийн өнөөдрийн тайлангийн хязгаар дууссан. Маргааш дахин оролдоно уу.",
        }[slot.code];
        return res.status(429).json({ error: msg, code: slot.code });
      }

      try {
        const result = await callClaude(content, MODEL, wardrobeCount ? WARDROBE_MAX_TOKENS : MAX_TOKENS);
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
      id, userId, claimToken, input, report, model: MODEL, cached, storeId: shop && shop.id,
      inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
    });
    console.log(JSON.stringify({ evt: "report", id, user: !!userId, store: shop && shop.slug, cached, ...usage }));

    const quota = await limits.remaining(store, ident);
    res.json({ report, id, saved: !!userId, claimToken, quota });
  }));

  // ---------- Дэлгүүрт туршиж буй зургийн хурдан шалгалт ----------
  // Зураг, хариу аль нь ч хадгалагдахгүй — зөвхөн хэрэглээний тоо (event) бичигдэнэ.

  app.post("/api/tryon", wrap(async (req, res) => {
    if (!API_KEY) {
      return res.status(500).json({ error: "Серверт ANTHROPIC_API_KEY тохируулаагүй байна." });
    }
    const body = req.body || {};
    const photo = body.photo || {};
    const mime = String(photo.mime || "image/jpeg");
    if (typeof photo.b64 !== "string" || !photo.b64 || !IMAGE_MIMES.has(mime)) {
      return res.status(400).json({ error: "Туршиж буй зургаа оруулна уу." });
    }
    if (photo.b64.length > MAX_TRYON_B64) {
      return res.status(413).json({ error: "Зураг хэт том байна. Жижиг зураг оруулна уу." });
    }

    const user = await currentUser(req);
    const userId = user ? user.id : null;
    const ident = { userId, ipHash: ipHash(req) };
    const shop = await currentStore(req);

    // Профайл: одоо бөглөсөн хариулт давамгайлж, дутууг нь өмнөх тайлангаас нөхнө
    let saved = {}, palette = [];
    if (userId) {
      saved = (await store.getLastInput(userId)) || {};
      const last = (await store.listReports(userId))[0];
      const rep = last && (await store.getReport(last.id, userId));
      palette = ((rep && rep.report && rep.report.ongo) || []).map((c) => String(c.ner || "").slice(0, 40)).filter(Boolean).slice(0, 6);
    }
    const profile = { ...saved, ...storableInput(body.profile || {}) };
    delete profile.season;
    const note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const { content } = buildTryonContent({ b64: photo.b64, mime }, profile, palette, note);

    const slot = await limits.reserve(store, limits.tryonBuckets(ident));
    if (!slot.ok) {
      const msg = {
        anon: "Өнөөдрийн үнэгүй шалгалт (" + limits.LIMITS.tryonAnonPerDay + ") дууссан. Бүртгүүлбэл өдөрт " + limits.LIMITS.tryonUserPerDay + " удаа шалгана.",
        user: "Өнөөдрийн шалгалтын хязгаар (" + limits.LIMITS.tryonUserPerDay + ") дууссан. Маргааш дахин оролдоно уу.",
        ip: "Энэ сүлжээнээс өнөөдөр хэт олон шалгалт хийсэн байна. Маргааш дахин оролдоно уу.",
        global: "Өнөөдөр хэрэглэгч их байгаа тул түр хязгаарласан. Маргааш дахин оролдоно уу.",
      }[slot.code];
      return res.status(429).json({ error: msg, code: slot.code });
    }

    let result, usage;
    try {
      ({ report: result, usage } = await callClaude(content, MODEL, TRYON_MAX_TOKENS));
    } catch (err) {
      await slot.release();
      console.error(err);
      return res.status(502).json({ error: "AI шалгалт хийхэд алдаа гарлаа. Дахин оролдоно уу." });
    }
    if (!TRYON_VERDICTS.includes(result.dun)) result.dun = "todorhoigui";

    await store.logEvent("tryon", userId, { model: MODEL, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 }, shop && shop.id);
    console.log(JSON.stringify({ evt: "tryon", user: !!userId, store: shop && shop.slug, dun: result.dun, ...usage }));

    const usedProfile = ["body", "skin", "undertone", "style", "height"].filter((k) => profile[k]);
    res.json({ result, usedProfile, usedPalette: palette.length > 0, quota: await limits.tryonRemaining(store, ident) });
  }));

  return app;
}

async function callClaude(content, model = MODEL, maxTokens = MAX_TOKENS) {
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
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    });
    const data = await r.json();
    if (data.error) throw new Error("Anthropic error: " + JSON.stringify(data.error));
    if (data.stop_reason === "max_tokens") throw new Error("Хариу max_tokens-д хүрч тасарсан: " + JSON.stringify(data.usage));

    let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s >= 0 && e >= 0) text = text.slice(s, e + 1);

    return { report: JSON.parse(text), usage: data.usage || {}, stopReason: data.stop_reason };
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
module.exports.callClaude = callClaude;
module.exports.PRICES = PRICES;
