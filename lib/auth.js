// Нууц үг hash хийх, session cookie гарын үсэг зурах/шалгах.
// Гадны сан ашиглахгүй — Node-ийн crypto (scrypt + HMAC).

const crypto = require("crypto");

const IS_PROD = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
const COOKIE = "ms_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 хоног

let SECRET = process.env.SESSION_SECRET;
const SECRET_MISSING = "SESSION_SECRET тохируулаагүй байна (production дээр заавал).";
if (!SECRET) {
  if (IS_PROD) {
    // Production дээр түр нууц үүсгэхгүй (instance бүр өөр нууцтай болж, session эвдэрнэ).
    // Нууц шаардсан үйлдэл бүр NOT_CONFIGURED алдаа шиднэ → API 503; статик хуудас ажилласаар.
    console.error(SECRET_MISSING);
  } else {
    // Локал хөгжүүлэлтэд түр нууц үүсгэнэ — сервер дахин асахад бүх хүн log out болно.
    SECRET = crypto.randomBytes(32).toString("hex");
    console.warn("SESSION_SECRET алга — түр нууц ашиглаж байна (зөвхөн локал).");
  }
}
function secret() {
  if (!SECRET) throw Object.assign(new Error(SECRET_MISSING), { code: "NOT_CONFIGURED" });
  return SECRET;
}
const hasSecret = () => !!SECRET;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored || "").split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function makeToken(userId, now = Date.now()) {
  const payload = `${userId}.${Math.floor(now / 1000) + MAX_AGE}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expected = Buffer.from(sign(`${userId}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 < now) return null;
  return userId;
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(userId) {
  const attrs = [`${COOKIE}=${makeToken(userId)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${MAX_AGE}`];
  if (IS_PROD) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PROD ? "; Secure" : ""}`;
}

function userIdFromRequest(req) {
  return readToken(parseCookies(req.headers.cookie)[COOKIE]);
}

// IP-г шууд хадгалахгүй, нууцтай hash болгоно.
function hashIp(ip) {
  return crypto.createHmac("sha256", secret()).update(String(ip || "?")).digest("hex").slice(0, 24);
}

module.exports = {
  hashPassword, verifyPassword, makeToken, readToken, parseCookies,
  sessionCookie, clearCookie, userIdFromRequest, hashIp, hasSecret,
};
