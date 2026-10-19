// API зардлын хяналт: үнэгүй хязгаар, IP хязгаар, өдрийн нийт cap.
// Тоолуурыг DB-д хадгалдаг тул serverless instance олон байсан ч ажиллана.

const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));

const LIMITS = {
  anonPerDay: num(process.env.FREE_ANON_PER_DAY, 1),      // нэвтрээгүй: IP тутамд өдөрт
  userPerMonth: num(process.env.FREE_USER_PER_MONTH, 5),  // бүртгэлтэй үнэгүй хэрэглэгч: сард
  ipPerDay: num(process.env.IP_PER_DAY, 10),              // нэг IP-аас өдөрт (олон account нээхээс хамгаална)
  globalPerDay: num(process.env.GLOBAL_PER_DAY, 300),     // бүх хэрэглэгч нийлээд өдөрт — credit шатаахаас хамгаалах
  authPerHour: num(process.env.AUTH_PER_HOUR, 20),        // нэвтрэх/бүртгүүлэх оролдлого IP тутамд цагт
  // Дэлгүүрт туршиж буй зургийн хурдан шалгалт — нэг зураг, богино хариу тул тайлангаас тусдаа, хямд
  tryonAnonPerDay: num(process.env.TRYON_ANON_PER_DAY, 3),
  tryonUserPerDay: num(process.env.TRYON_USER_PER_DAY, 20),
  tryonIpPerDay: num(process.env.TRYON_IP_PER_DAY, 40),
  tryonGlobalPerDay: num(process.env.TRYON_GLOBAL_PER_DAY, 1000),
};

// Улаанбаатарын цагаар (UTC+8) өдөр, сар
function ubDate(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString();
}
const dayKey = (now) => ubDate(now).slice(0, 10);
const monthKey = (now) => ubDate(now).slice(0, 7);
const hourKey = (now) => ubDate(now).slice(0, 13);

// UB-ийн өнөөдрийн 00:00-ийг UTC ISO хэлбэрээр (stats-д)
function ubDayStartIso(now = Date.now()) {
  return new Date(Date.parse(dayKey(now) + "T00:00:00Z") - 8 * 3600e3).toISOString();
}

function reportBuckets({ userId, ipHash }, now = Date.now()) {
  const d = dayKey(now);
  const buckets = [
    { key: `global:${d}`, limit: LIMITS.globalPerDay, code: "global" },
    { key: `ip:${ipHash}:${d}`, limit: LIMITS.ipPerDay, code: "ip" },
  ];
  if (userId) buckets.push({ key: `user:${userId}:${monthKey(now)}`, limit: LIMITS.userPerMonth, code: "user" });
  else buckets.push({ key: `anon:${ipHash}:${d}`, limit: LIMITS.anonPerDay, code: "anon" });
  return buckets;
}

function tryonBuckets({ userId, ipHash }, now = Date.now()) {
  const d = dayKey(now);
  return [
    { key: `tryon:global:${d}`, limit: LIMITS.tryonGlobalPerDay, code: "global" },
    { key: `tryon:ip:${ipHash}:${d}`, limit: LIMITS.tryonIpPerDay, code: "ip" },
    userId
      ? { key: `tryon:user:${userId}:${d}`, limit: LIMITS.tryonUserPerDay, code: "user" }
      : { key: `tryon:anon:${ipHash}:${d}`, limit: LIMITS.tryonAnonPerDay, code: "anon" },
  ];
}

// Эхлээд тоолуурыг нэмээд (захиалж), хэтэрсэн бол буцаана. Ингэснээр зэрэг ирсэн
// хүсэлтүүд хязгаарыг давахгүй. Амжилттай бол release() — AI алдаа гарвал буцааж өгөх.
async function reserve(store, buckets) {
  const taken = [];
  for (const b of buckets) {
    const count = await store.incrUsage(b.key, 1);
    taken.push(b);
    if (count > b.limit) {
      await Promise.all(taken.map((t) => store.incrUsage(t.key, -1)));
      return { ok: false, code: b.code };
    }
  }
  return { ok: true, release: () => Promise.all(taken.map((t) => store.incrUsage(t.key, -1))) };
}

async function remaining(store, { userId, ipHash }, now = Date.now()) {
  const own = reportBuckets({ userId, ipHash }, now).find((b) => b.code === "user" || b.code === "anon");
  const used = await store.getUsage(own.key);
  return { used, limit: own.limit, left: Math.max(0, own.limit - used), period: userId ? "month" : "day" };
}

async function tryonRemaining(store, ident, now = Date.now()) {
  const own = tryonBuckets(ident, now)[2];
  const used = await store.getUsage(own.key);
  return { used, limit: own.limit, left: Math.max(0, own.limit - used), period: "day" };
}

module.exports = { LIMITS, reportBuckets, tryonBuckets, reserve, remaining, tryonRemaining, dayKey, hourKey, ubDayStartIso };
