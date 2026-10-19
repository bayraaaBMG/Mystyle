// node --test — Claude-г mock хийж, бүртгэл / хязгаар / cache / хадгалалтыг шалгана.
// TEST_DATABASE_URL өгвөл бодит Postgres дээр ажиллана (хүснэгтүүдийг устгаад дахин үүсгэнэ — тусдаа тест DB ашигла!).

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_TOKEN = "admin-secret";
process.env.FREE_ANON_PER_DAY = "1";
process.env.FREE_USER_PER_MONTH = "2";
process.env.SUPER_ADMIN_EMAILS = "boss@my.mn";

const test = require("node:test");
const assert = require("node:assert");
const { createApp } = require("../server");
const { createFileStore } = require("../lib/store-file");
const { createPgStore } = require("../lib/store-pg");
const auth = require("../lib/auth");

const realFetch = global.fetch;
let claudeCalls = 0;

function mockClaude() {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("https://api.anthropic.com")) {
      claudeCalls++;
      return { json: async () => ({ content: [{ type: "text", text: '{"tovch":"Сайн байна","ongo":[]}' }], usage: { input_tokens: 1000, output_tokens: 500 } }) };
    }
    return realFetch(url, opts);
  };
}

const PG_URL = process.env.TEST_DATABASE_URL;
console.log("store:", PG_URL ? "postgres" : "file");

async function freshStore() {
  if (!PG_URL) return createFileStore(null);
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: PG_URL });
  await pool.query("drop table if exists store_admins, reports, users, quota_usage, report_cache, events, stores cascade");
  await pool.end();
  return createPgStore(PG_URL);
}

async function startServer() {
  const store = await freshStore();
  const app = createApp(store);
  const server = app.listen(0);
  server.on("close", () => store.close && store.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body, cookie, headers = {} } = {}) => {
    const res = await realFetch(base + path, {
      method,
      redirect: "manual",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch (e) { /* HTML */ }
    return { status: res.status, data, cookie: setCookie && setCookie.split(";")[0], location: res.headers.get("location") };
  };
  return { server, call };
}

const quiz = (occasion) => ({ gender: "Эмэгтэй", height: "165", body: "Шулуун", occasion, season: "намар" });

test("password hash болон session token", () => {
  const h = auth.hashPassword("supersecret");
  assert.ok(auth.verifyPassword("supersecret", h));
  assert.ok(!auth.verifyPassword("wrong-pass", h));
  const t = auth.makeToken("u1");
  assert.strictEqual(auth.readToken(t), "u1");
  assert.strictEqual(auth.readToken(t.slice(0, -2) + "xx"), null);
  assert.strictEqual(auth.readToken(t, Date.now() + 31 * 864e5), null);
});

test("бүртгэл, хязгаар, cache, тайлан хадгалах", async (t) => {
  mockClaude();
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });

  // Нэвтрээгүй: өдөрт 1
  let r = await call("/api/style", { method: "POST", body: quiz("Ажил") });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.saved, false);
  assert.ok(r.data.claimToken);
  const claimToken = r.data.claimToken;

  // Ижил хариулт → cache, Claude дахин дуудагдахгүй, хязгаар хасагдахгүй
  r = await call("/api/style", { method: "POST", body: quiz("Ажил") });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(claudeCalls, 1);

  // Өөр хариулт → хязгаар хэтэрсэн
  r = await call("/api/style", { method: "POST", body: quiz("Болзоо") });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.code, "anon");

  // Бүртгүүлэхэд өмнөх тайлан холбогдоно
  r = await call("/api/auth/register", { method: "POST", body: { email: "A@b.mn", password: "password1", claimToken } });
  assert.strictEqual(r.status, 200);
  const cookie = r.cookie;
  assert.ok(cookie);

  r = await call("/api/auth/register", { method: "POST", body: { email: "a@b.mn", password: "password1" } });
  assert.strictEqual(r.status, 409);

  r = await call("/api/auth/login", { method: "POST", body: { email: "a@b.mn", password: "nope-nope" } });
  assert.strictEqual(r.status, 401);

  r = await call("/api/reports", { cookie });
  assert.strictEqual(r.data.reports.length, 1);

  // Бүртгэлтэй: сард 2
  r = await call("/api/style", { method: "POST", body: quiz("Болзоо"), cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.saved, true);
  assert.strictEqual(r.data.quota.left, 1);
  r = await call("/api/style", { method: "POST", body: quiz("Ярилцлага"), cookie });
  assert.strictEqual(r.status, 200);
  r = await call("/api/style", { method: "POST", body: quiz("Өдөр тутам"), cookie });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.code, "user");

  r = await call("/api/reports", { cookie });
  assert.strictEqual(r.data.reports.length, 3);
  const one = await call("/api/reports/" + r.data.reports[0].id, { cookie });
  assert.strictEqual(one.data.report.tovch, "Сайн байна");

  // Өөр хүний тайлан харагдахгүй
  const other = await call("/api/auth/register", { method: "POST", body: { email: "c@d.mn", password: "password2" } });
  const forbidden = await call("/api/reports/" + r.data.reports[0].id, { cookie: other.cookie });
  assert.strictEqual(forbidden.status, 404);

  // Admin stats
  assert.strictEqual((await call("/api/admin/stats")).status, 401);
  const stats = await realFetch(`http://127.0.0.1:${server.address().port}/api/admin/stats`, {
    headers: { Authorization: "Bearer admin-secret" },
  }).then((x) => x.json());
  assert.strictEqual(stats.users, 2);
  assert.strictEqual(stats.reports.total, 4);
  assert.strictEqual(stats.reports.cached, 1);
  assert.strictEqual(stats.returningUsers, 1);
  assert.strictEqual(stats.reports.input_tokens, 3000);

  // Бүртгэл устгах
  r = await call("/api/me", { method: "DELETE", cookie });
  assert.strictEqual(r.status, 200);
  r = await call("/api/me", { cookie });
  assert.strictEqual(r.data.user, null);
});

test("AI алдаа гарвал хязгаар буцааж өгнө", async (t) => {
  global.fetch = async (url, opts) =>
    String(url).startsWith("https://api.anthropic.com")
      ? { json: async () => ({ error: { type: "overloaded_error" } }) }
      : realFetch(url, opts);
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });

  let r = await call("/api/style", { method: "POST", body: quiz("Ажил") });
  assert.strictEqual(r.status, 502);
  r = await call("/api/me");
  assert.strictEqual(r.data.quota.left, 1);
});

test("зэрэг ирсэн хүсэлтүүд хязгаарыг давахгүй", async (t) => {
  mockClaude();
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });

  const occasions = ["Ажил", "Болзоо", "Ярилцлага", "Өдөр тутам", "Найр / Эвент", "a", "b", "c", "d", "e"];
  const results = await Promise.all(occasions.map((o) => call("/api/style", { method: "POST", body: quiz(o) })));
  assert.strictEqual(results.filter((r) => r.status === 200).length, 1);
  assert.strictEqual(results.filter((r) => r.status === 429).length, occasions.length - 1);
});

test("өмнөх хариулт /api/me-д буцна, хэмжээ цэвэрлэгдэнэ", async (t) => {
  mockClaude();
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });

  const reg = await call("/api/auth/register", { method: "POST", body: { email: "p@q.mn", password: "password1" } });
  let me = await call("/api/me", { cookie: reg.cookie });
  assert.strictEqual(me.data.lastInput, null);

  await call("/api/style", { method: "POST", cookie: reg.cookie, body: { ...quiz("Ажил"), chest: "90", waist: "abc", hips: "5000" } });
  me = await call("/api/me", { cookie: reg.cookie });
  assert.strictEqual(me.data.lastInput.occasion, "Ажил");
  assert.strictEqual(me.data.lastInput.chest, "90");
  assert.strictEqual(me.data.lastInput.waist, undefined);
  assert.strictEqual(me.data.lastInput.hips, undefined);
});

test("max_tokens-д тасарсан хариу 502 болж, эрх буцна", async (t) => {
  global.fetch = async (url, opts) =>
    String(url).startsWith("https://api.anthropic.com")
      ? { json: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"tovch":"тасар' }], usage: {} }) }
      : realFetch(url, opts);
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });

  const r = await call("/api/style", { method: "POST", body: quiz("Ажил") });
  assert.strictEqual(r.status, 502);
  assert.strictEqual((await call("/api/me")).data.quota.left, 1);
});

test("multi-tenant: дэлгүүр, роль, store_id, дэлгүүрийн хязгаар", async (t) => {
  mockClaude();
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });
  const reg = (email) => call("/api/auth/register", { method: "POST", body: { email, password: "password1" } }).then((r) => r.cookie);

  const boss = await reg("boss@my.mn");
  const shopAdmin = await reg("shop@my.mn");
  const customer = await reg("cust@my.mn");
  assert.strictEqual((await call("/api/me", { cookie: boss })).data.user.role, "SUPER_ADMIN");
  assert.strictEqual((await call("/api/me", { cookie: customer })).data.user.role, "USER");

  // Эрхийн шалгалт
  assert.strictEqual((await call("/api/admin/stores")).status, 401);
  assert.strictEqual((await call("/api/admin/stores", { cookie: customer })).status, 403);
  assert.strictEqual((await call("/api/admin/stats", { cookie: customer })).status, 403);

  // Дэлгүүр үүсгэх
  let r = await call("/api/admin/stores", { method: "POST", cookie: boss, body: { name: "Nomin Fashion", slug: "nomin", accent: "#123456", dailyCap: 1 } });
  assert.strictEqual(r.status, 200);
  const nomin = r.data.store;
  assert.strictEqual((await call("/api/admin/stores", { method: "POST", cookie: boss, body: { name: "X", slug: "nomin" } })).status, 409);
  assert.strictEqual((await call("/api/admin/stores", { method: "POST", cookie: boss, body: { name: "X", slug: "Bad Slug!" } })).status, 400);
  r = await call("/api/admin/stores", { method: "POST", cookie: boss, body: { name: "Other", slug: "other" } });
  const other = r.data.store;

  // Дэлгүүрийн хуудас, PWA manifest
  r = await call("/s/nomin");
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.includes('href="/s/nomin/manifest.json"'));
  r = await call("/s/nomin/manifest.json");
  assert.strictEqual(r.data.start_url, "/s/nomin");
  assert.strictEqual(r.data.name, "Nomin Fashion — MyStyle AI");
  assert.strictEqual((await call("/s/unknown")).status, 302);
  assert.strictEqual((await call("/api/store/nomin")).data.name, "Nomin Fashion");

  // Дэлгүүрээр тайлан → store_id хадгалагдана; өдрийн хязгаар (1) ажиллана
  const X = { "X-Store": "nomin" };
  assert.strictEqual((await call("/api/style", { method: "POST", cookie: customer, headers: X, body: quiz("Ажил") })).status, 200);
  r = await call("/api/style", { method: "POST", cookie: customer, headers: X, body: quiz("Болзоо") });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.code, "store");
  // Дэлгүүргүй (үндсэн апп) тайлан
  assert.strictEqual((await call("/api/style", { method: "POST", cookie: customer, body: quiz("Болзоо") })).status, 200);

  // Дэлгүүрийн админ оноох
  assert.strictEqual((await call(`/api/admin/stores/${nomin.id}/admins`, { method: "POST", cookie: boss, body: { email: "nobody@my.mn" } })).status, 404);
  assert.strictEqual((await call(`/api/admin/stores/${nomin.id}/admins`, { method: "POST", cookie: boss, body: { email: "boss@my.mn" } })).status, 400);
  r = await call(`/api/admin/stores/${nomin.id}/admins`, { method: "POST", cookie: boss, body: { email: "shop@my.mn", level: "OWNER" } });
  assert.strictEqual(r.data.admin.level, "OWNER");
  assert.strictEqual((await call("/api/me", { cookie: shopAdmin })).data.user.role, "STORE_ADMIN");

  // STORE_ADMIN зөвхөн өөрийн дэлгүүрийн нийлбэрийг харна
  r = await call("/api/admin/stats", { cookie: shopAdmin });
  assert.strictEqual(r.data.reports.total, 1);
  assert.strictEqual(r.data.users, 1);
  assert.strictEqual((await call("/api/admin/stats?store=" + other.id, { cookie: shopAdmin })).status, 403); // өөр дэлгүүр
  assert.strictEqual((await call("/api/admin/stores", { cookie: shopAdmin })).status, 403);
  assert.strictEqual((await call(`/api/admin/stores/${other.id}`, { method: "PATCH", cookie: shopAdmin, body: { name: "Hack" } })).status, 403);
  r = await call(`/api/admin/stores/${nomin.id}`, { method: "PATCH", cookie: shopAdmin, body: { name: "Nomin 2", dailyCap: 9999, active: false } });
  assert.strictEqual(r.data.store.name, "Nomin 2");
  assert.strictEqual(r.data.store.daily_cap, 1); // STORE_ADMIN хязгаар өөрчлөхгүй
  assert.strictEqual(r.data.store.active, true);

  // SUPER_ADMIN: бүх систем ба дэлгүүрээр
  assert.strictEqual((await call("/api/admin/stats", { cookie: boss })).data.reports.total, 2);
  assert.strictEqual((await call("/api/admin/stats?store=" + nomin.id, { cookie: boss })).data.reports.total, 1);
  r = await call("/api/admin/stores", { cookie: boss });
  assert.strictEqual(r.data.stores.find((s) => s.id === nomin.id).admins, 1);

  // Зогсоосон дэлгүүр нээгдэхгүй
  await call(`/api/admin/stores/${nomin.id}`, { method: "PATCH", cookie: boss, body: { active: false } });
  assert.strictEqual((await call("/api/store/nomin")).status, 404);
  assert.strictEqual((await call("/s/nomin")).status, 302);

  // Сүүлийн OWNER-ийг SUPER_ADMIN ч хасахгүй; өөр OWNER нэмсний дараа хасна
  const shopUser = (await call("/api/me", { cookie: shopAdmin })).data.user;
  r = await call(`/api/admin/stores/${nomin.id}/admins/${shopUser.id}`, { method: "DELETE", cookie: boss });
  assert.strictEqual(r.status, 400);
  await call(`/api/admin/stores/${nomin.id}/admins`, { method: "POST", cookie: boss, body: { email: "cust@my.mn", level: "OWNER" } });
  assert.strictEqual((await call(`/api/admin/stores/${nomin.id}/admins/${shopUser.id}`, { method: "DELETE", cookie: boss })).status, 200);
  assert.strictEqual((await call("/api/admin/stats", { cookie: shopAdmin })).status, 403);
});

test("шүүгээ: prompt-д хувцасны үнэлгээ, 7 хоногийн төлөвлөгөө орно", () => {
  const { buildContent } = require("../lib/prompt");
  const img = { b64: "aGVsbG8=", mime: "image/jpeg" };
  const withW = buildContent({ ...quiz("Ажил"), wardrobe: [img, img, img] });
  assert.strictEqual(withW.wardrobeCount, 3);
  assert.ok(withW.promptText.includes('"tohiroh":"маш сайн | сайн | дунд | бага"'));
  assert.ok(withW.promptText.includes("wardrobe_week"));
  assert.ok(withW.promptText.includes("яг 7 өдөр"));
  assert.ok(withW.promptText.includes("(нийт 3 ширхэг)"));
  const noW = buildContent(quiz("Ажил"));
  assert.ok(noW.promptText.includes("wardrobe_week-ийг хоосон массив"));
});

test("try-on: профайл нөхнө, юу ч хадгалахгүй, тусдаа хязгаартай", async (t) => {
  const prompts = [];
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith("https://api.anthropic.com")) return realFetch(url, opts);
    const content = JSON.parse(opts.body).messages[0].content;
    const text = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const isTryon = text.includes("дэлгүүрт хувцас өмсөж туршиж");
    if (isTryon) prompts.push({ text, maxTokens: JSON.parse(opts.body).max_tokens, images: content.filter((b) => b.type === "image").length });
    const out = isTryon
      ? '{"dun":"tohirno","garchig":"Танд зохиж байна","yagaad":["Өнгө тань дулаан undertone-д тохирно"],"oorchlolt":["Бор гуталтай хослуул"],"razmer":"Мөр яг таарч байна"}'
      : '{"tovch":"Сайн байна","ongo":[{"ner":"Тоосго улаан","hex":"#B5482B"},{"ner":"Цөцгий","hex":"#F3E7C9"}]}';
    return { json: async () => ({ content: [{ type: "text", text: out }], usage: { input_tokens: 800, output_tokens: 200 } }) };
  };
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });
  const photo = { b64: "aGVsbG8=", mime: "image/jpeg" };

  // Зураггүй / буруу төрөл
  assert.strictEqual((await call("/api/tryon", { method: "POST", body: {} })).status, 400);
  assert.strictEqual((await call("/api/tryon", { method: "POST", body: { photo: { b64: "x", mime: "text/html" } } })).status, 400);

  // Бүртгэлтэй хэрэглэгч эхлээд тест бөглөсөн
  const reg = await call("/api/auth/register", { method: "POST", body: { email: "t@r.mn", password: "password1" } });
  await call("/api/style", { method: "POST", cookie: reg.cookie, body: { ...quiz("Ажил"), body: "Цаг хэлбэр", undertone: "Дулаан" } });
  const before = (await call("/api/reports", { cookie: reg.cookie })).data.reports.length;

  // Одоо бөглөсөн стиль давамгайлж, бусдыг өмнөх тайлангаас нөхнө
  let r = await call("/api/tryon", { method: "POST", cookie: reg.cookie, body: { photo, profile: { style: "Спорт" }, note: "M размер" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.result.dun, "tohirno");
  assert.strictEqual(r.data.usedPalette, true);
  assert.ok(r.data.usedProfile.includes("body"));
  const p = prompts[0];
  assert.strictEqual(p.images, 1);
  assert.strictEqual(p.maxTokens, 1500);
  assert.ok(p.text.includes("Биеийн хэлбэр: Цаг хэлбэр"));
  assert.ok(p.text.includes("Өнгөлөг: Дулаан"));
  assert.ok(p.text.includes("Дуртай стиль: Спорт"));
  assert.ok(p.text.includes("Тоосго улаан, Цөцгий"));
  assert.ok(p.text.includes("«M размер»"));

  // Тайлан нэмэгдээгүй, тайлангийн эрх хасагдаагүй
  assert.strictEqual((await call("/api/reports", { cookie: reg.cookie })).data.reports.length, before);
  const me = await call("/api/me", { cookie: reg.cookie });
  assert.strictEqual(me.data.quota.left, 1);
  assert.strictEqual(me.data.tryonQuota.left, 19);

  // Нэвтрээгүй: өдөрт 3, дараа нь 429; тайлангийн эрх хэвээр
  for (let i = 0; i < 3; i++) assert.strictEqual((await call("/api/tryon", { method: "POST", body: { photo } })).status, 200);
  r = await call("/api/tryon", { method: "POST", body: { photo } });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.code, "anon");
  assert.strictEqual((await call("/api/me")).data.quota.left, 1);
  assert.ok(prompts[1].text.includes("Биеийн хэлбэр: хэлээгүй"));
});

test("try-on: AI алдаа гарвал эрх буцна, үл мэдэгдэх дүгнэлт todorhoigui болно", async (t) => {
  let fail = true;
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith("https://api.anthropic.com")) return realFetch(url, opts);
    if (fail) return { json: async () => ({ error: { type: "overloaded_error" } }) };
    return { json: async () => ({ content: [{ type: "text", text: '{"dun":"maybe","garchig":"?"}' }], usage: {} }) };
  };
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });
  const photo = { b64: "aGVsbG8=", mime: "image/png" };

  assert.strictEqual((await call("/api/tryon", { method: "POST", body: { photo } })).status, 502);
  assert.strictEqual((await call("/api/me")).data.tryonQuota.left, 3);
  fail = false;
  const r = await call("/api/tryon", { method: "POST", body: { photo } });
  assert.strictEqual(r.data.result.dun, "todorhoigui");
});

test("олон админ: OWNER баг удирдана, MANAGER үгүй, нэг админ олон дэлгүүр", async (t) => {
  mockClaude();
  const { server, call } = await startServer();
  t.after(() => { server.closeAllConnections(); server.close(); global.fetch = realFetch; });
  const reg = (email) => call("/api/auth/register", { method: "POST", body: { email, password: "password1" } }).then((r) => r.cookie);
  const boss = await reg("boss@my.mn");
  const owner = await reg("owner@my.mn");
  const mgr = await reg("mgr@my.mn");
  const third = await reg("third@my.mn");
  const mk = (name, slug) => call("/api/admin/stores", { method: "POST", cookie: boss, body: { name, slug } }).then((r) => r.data.store);
  const a = await mk("Store A", "store-a");
  const b = await mk("Store B", "store-b");
  const c = await mk("Store C", "store-c");
  const add = (id, cookie, email, level) => call(`/api/admin/stores/${id}/admins`, { method: "POST", cookie, body: { email, level } });
  const userId = async (cookie) => (await call("/api/me", { cookie })).data.user.id;

  // SUPER_ADMIN нэг хүнийг хоёр дэлгүүрийн OWNER болгоно
  assert.strictEqual((await add(a.id, boss, "owner@my.mn", "OWNER")).status, 200);
  assert.strictEqual((await add(b.id, boss, "owner@my.mn", "OWNER")).status, 200);
  assert.strictEqual((await add(a.id, boss, "owner@my.mn", "ADMIN")).status, 400);
  let me = await call("/api/admin/me", { cookie: owner });
  assert.deepStrictEqual(me.data.stores.map((s) => [s.slug, s.level]).sort(), [["store-a", "OWNER"], ["store-b", "OWNER"]]);

  // OWNER өөрийн дэлгүүрт MANAGER нэмнэ, өөр дэлгүүрт үгүй
  assert.strictEqual((await add(a.id, owner, "mgr@my.mn", "MANAGER")).status, 200);
  assert.strictEqual((await add(c.id, owner, "mgr@my.mn", "MANAGER")).status, 403);
  assert.strictEqual((await add(a.id, owner, "boss@my.mn", "MANAGER")).status, 400);
  assert.strictEqual((await add(a.id, owner, "nobody@my.mn", "MANAGER")).status, 404);
  let admins = (await call(`/api/admin/stores/${a.id}/admins`, { cookie: owner })).data.admins;
  assert.deepStrictEqual(admins.map((x) => [x.email, x.level]), [["owner@my.mn", "OWNER"], ["mgr@my.mn", "MANAGER"]]);

  // MANAGER: статистик, нэр/өнгө — тийм; баг харах/удирдах, хязгаар — үгүй
  assert.strictEqual((await call("/api/admin/me", { cookie: mgr })).data.stores[0].level, "MANAGER");
  assert.strictEqual((await call(`/api/admin/stores/${a.id}/admins`, { cookie: mgr })).status, 403);
  assert.strictEqual((await add(a.id, mgr, "third@my.mn", "MANAGER")).status, 403);
  assert.strictEqual((await call(`/api/admin/stores/${a.id}/admins/${await userId(owner)}`, { method: "DELETE", cookie: mgr })).status, 403);
  let r = await call(`/api/admin/stores/${a.id}`, { method: "PATCH", cookie: mgr, body: { name: "Store A2", dailyCap: 5 } });
  assert.strictEqual(r.data.store.name, "Store A2");
  assert.strictEqual(r.data.store.daily_cap, null);
  assert.strictEqual((await call(`/api/admin/stores/${b.id}`, { method: "PATCH", cookie: mgr, body: { name: "x" } })).status, 403);
  assert.strictEqual((await call("/api/admin/stats", { cookie: mgr })).status, 200);
  assert.strictEqual((await call("/api/admin/stores", { cookie: owner })).status, 403); // бүх дэлгүүрийн жагсаалт — SUPER_ADMIN

  // Статистик: OWNER нийлбэр (A+B) эсвэл нэг дэлгүүр; өөр дэлгүүр 403
  const cust = await reg("cust@my.mn");
  await call("/api/style", { method: "POST", cookie: cust, headers: { "X-Store": "store-a" }, body: quiz("Ажил") });
  await call("/api/style", { method: "POST", cookie: cust, headers: { "X-Store": "store-b" }, body: quiz("Болзоо") });
  await call("/api/style", { method: "POST", cookie: cust, headers: { "X-Store": "store-c" }, body: quiz("Ярилцлага") });
  assert.strictEqual((await call("/api/admin/stats", { cookie: owner })).data.reports.total, 2);
  assert.strictEqual((await call("/api/admin/stats?store=" + b.id, { cookie: owner })).data.reports.total, 1);
  assert.strictEqual((await call("/api/admin/stats?store=" + c.id, { cookie: owner })).status, 403);
  assert.strictEqual((await call("/api/admin/stats", { cookie: mgr })).data.reports.total, 1);

  // Сүүлийн OWNER: хасахгүй, MANAGER болгохгүй
  const ownerId = await userId(owner);
  r = await call(`/api/admin/stores/${a.id}/admins/${ownerId}`, { method: "DELETE", cookie: owner });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await add(a.id, owner, "owner@my.mn", "MANAGER")).status, 400);
  // MANAGER-ийг OWNER болгосны дараа анхны OWNER өөрийгөө хасаж болно
  assert.strictEqual((await add(a.id, owner, "mgr@my.mn", "OWNER")).status, 200);
  assert.strictEqual((await call(`/api/admin/stores/${a.id}/admins/${ownerId}`, { method: "DELETE", cookie: owner })).status, 200);
  me = await call("/api/admin/me", { cookie: owner });
  assert.deepStrictEqual(me.data.stores.map((s) => s.slug), ["store-b"]);
  assert.strictEqual((await call(`/api/admin/stores/${a.id}/admins`, { cookie: owner })).status, 403);

  // Админ биш хэрэглэгч
  assert.strictEqual((await call("/api/admin/me", { cookie: third })).status, 403);
  assert.strictEqual((await call("/api/me", { cookie: third })).data.user.role, "USER");
  // Хэрэглэгчийн тал өөрчлөгдөхгүй: дэлгүүрийн хуудас ажиллана
  assert.strictEqual((await call("/s/store-a")).status, 200);
});

test("migration: хуучин STORE_ADMIN + store_id нэг удаа OWNER болно", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mystyle-")), "db.json");
  fs.writeFileSync(file, JSON.stringify({
    users: [
      { id: "u1", email: "old@my.mn", pass_hash: "x", role: "STORE_ADMIN", store_id: "s1", created_at: "2026-01-01T00:00:00Z" },
      { id: "u2", email: "user@my.mn", pass_hash: "x", role: "USER", store_id: null, created_at: "2026-01-01T00:00:00Z" },
    ],
    stores: [{ id: "s1", slug: "old", name: "Old", active: true, daily_cap: null, created_at: "2026-01-01T00:00:00Z" }],
  }));
  let st = createFileStore(file);
  assert.deepStrictEqual(await st.listStoreAdmins("s1"), [{ id: "u1", email: "old@my.mn", level: "OWNER" }]);
  assert.strictEqual((await st.listUserStores("u2")).length, 0);
  // Хассаны дараа дахин ачаалахад буцаж ирэхгүй (хуулалт нэг удаа)
  await st.setStoreAdmin("s1", "u2", "OWNER");
  await st.removeStoreAdmin("s1", "u1");
  st = createFileStore(file);
  assert.deepStrictEqual((await st.listStoreAdmins("s1")).map((a) => a.id), ["u2"]);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
