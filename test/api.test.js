// node --test — Claude-г mock хийж, бүртгэл / хязгаар / cache / хадгалалтыг шалгана.
// TEST_DATABASE_URL өгвөл бодит Postgres дээр ажиллана (хүснэгтүүдийг устгаад дахин үүсгэнэ — тусдаа тест DB ашигла!).

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_TOKEN = "admin-secret";
process.env.FREE_ANON_PER_DAY = "1";
process.env.FREE_USER_PER_MONTH = "2";

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
  await pool.query("drop table if exists reports, users, quota_usage, report_cache, events cascade");
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
  const call = async (path, { method = "GET", body, cookie } = {}) => {
    const res = await realFetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    return { status: res.status, data: await res.json(), cookie: setCookie && setCookie.split(";")[0] };
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
