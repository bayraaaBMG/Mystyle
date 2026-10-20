// Deploy хийсний дараах шалгалт.
//   node scripts/smoke.js <URL>            — зөвхөн уншина (хуудас, PWA, DB холболт)
//   node scripts/smoke.js <URL> --write    — түр хэрэглэгч бүртгээд устгана (auth + DB бичилт)
//   node scripts/smoke.js <URL> --report   — дээрхээс гадна бодит Claude-оор 1 тайлан (~$0.05–0.10)
// Vercel preview хамгаалалттай бол VERCEL_BYPASS=<token> орчны хувьсагч өгнө.

const BASE = (process.argv[2] || "").replace(/\/$/, "");
const WRITE = process.argv.includes("--write") || process.argv.includes("--report");
const REPORT = process.argv.includes("--report");
if (!/^https?:\/\//.test(BASE)) {
  console.error("Хэрэглээ: node scripts/smoke.js https://<домэйн> [--write] [--report]");
  process.exit(1);
}

const bypass = process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {};
let cookie = "";
let failed = 0;

async function req(path, { method = "GET", body } = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...bypass, ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* HTML */ }
  return { status: res.status, type: res.headers.get("content-type") || "", text, json, ms: Date.now() - t0 };
}

async function check(name, fn) {
  try {
    const note = await fn();
    console.log("✓", name, note ? `— ${note}` : "");
  } catch (e) {
    failed++;
    console.log("✗", name, "—", e.message);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  console.log("Шалгаж байна:", BASE, WRITE ? "(бичилттэй)" : "(зөвхөн унших)");

  await check("Нүүр хуудас", async () => {
    const r = await req("/");
    expect(r.status === 200, "status " + r.status);
    expect(r.text.includes('rel="manifest"'), "manifest холбоос алга");
  });
  await check("manifest.json", async () => {
    const r = await req("/manifest.json");
    expect(r.status === 200 && r.json && r.json.icons.length >= 3, "status " + r.status);
  });
  await check("Service worker", async () => {
    const r = await req("/sw.js");
    expect(r.status === 200 && /javascript/.test(r.type), `status ${r.status}, ${r.type}`);
  });
  await check("Icon PNG", async () => {
    const r = await req("/icon-192.png");
    expect(r.status === 200 && /png/.test(r.type), `status ${r.status}, ${r.type}`);
  });
  await check("Нууцлалын бодлого, админ хуудас", async () => {
    const [p, a] = await Promise.all([req("/privacy.html"), req("/admin.html")]);
    expect(p.status === 200 && a.status === 200, `privacy ${p.status}, admin ${a.status}`);
  });
  await check("Тохиргоо (/api/health)", async () => {
    const r = await req("/api/health");
    const j = r.json || {};
    expect(r.status === 200, `status ${r.status} — db:${j.db} sessionSecret:${j.sessionSecret} anthropicKey:${j.anthropicKey}`);
    return `model ${j.model}`;
  });
  await check("DB холболт (/api/me)", async () => {
    const r = await req("/api/me");
    expect(r.status === 200 && r.json && r.json.quota, `status ${r.status} ${r.text.slice(0, 120)}`);
    return `${r.ms}ms, үнэгүй хязгаар ${r.json.quota.left}/${r.json.quota.limit}`;
  });
  await check("Байхгүй дэлгүүр /s/... → нүүр рүү", async () => {
    const r = await req("/s/no-such-store-xyz");
    expect(r.status === 302, "status " + r.status);
  });
  await check("Админ API хамгаалалттай", async () => {
    const r = await req("/api/admin/stores");
    expect(r.status === 401, "status " + r.status);
  });

  if (WRITE) {
    const email = `smoke-${Date.now()}@example.com`;
    await check("Бүртгүүлэх (түр хэрэглэгч)", async () => {
      const r = await req("/api/auth/register", { method: "POST", body: { email, password: "smoke-test-pass" } });
      expect(r.status === 200 && cookie, `status ${r.status} ${r.text.slice(0, 120)}`);
      return email;
    });
    await check("Нэвтэрсэн төлөв", async () => {
      const r = await req("/api/me");
      expect(r.json && r.json.user && r.json.user.email === email, r.text.slice(0, 120));
    });
    if (REPORT) {
      await check("Бодит Claude тайлан", async () => {
        const r = await req("/api/style", {
          method: "POST",
          body: { gender: "Эмэгтэй", height: "165", weight: "58", body: "Цаг хэлбэр", undertone: "Дулаан", style: "Цэвэрхэн / Minimal", occasion: "Ажил", season: "сэрүүсэж буй намар" },
        });
        expect(r.status === 200 && r.json && r.json.report, `status ${r.status} (${(r.ms / 1000).toFixed(1)}s) ${r.text.slice(0, 160)}`);
        const rep = r.json.report;
        const parts = ["ongo", "razmer", "outfit", "delguur"].filter((k) => rep[k]);
        return `${(r.ms / 1000).toFixed(1)}s, хэсгүүд: ${parts.join(", ")}`;
      });
    }
    await check("Түр хэрэглэгчийг устгах", async () => {
      const r = await req("/api/me", { method: "DELETE" });
      expect(r.status === 200, "status " + r.status);
    });
  }

  console.log(failed ? `\n${failed} шалгалт амжилтгүй.` : "\nБүх шалгалт амжилттай.");
  process.exit(failed ? 1 : 0);
})();
