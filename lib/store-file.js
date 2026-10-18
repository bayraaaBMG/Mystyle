// JSON файл store — зөвхөн локал хөгжүүлэлт, тестэд. Vercel дээр файл хадгалагдахгүй.
// Postgres store-той ижил интерфэйстэй.

const fs = require("fs");
const path = require("path");

function createFileStore(file) {
  let db = { users: [], reports: [], usage: {}, cache: {}, events: [] };
  if (file && fs.existsSync(file)) db = { ...db, ...JSON.parse(fs.readFileSync(file, "utf8")) };

  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db));
  };
  const now = () => new Date().toISOString();
  const pick = (u) => u && { id: u.id, email: u.email, created_at: u.created_at };

  return {
    kind: "file",

    async createUser(id, email, passHash) {
      if (db.users.some((u) => u.email === email)) return null;
      const u = { id, email, pass_hash: passHash, created_at: now() };
      db.users.push(u);
      save();
      return pick(u);
    },
    async getUserByEmail(email) {
      return db.users.find((u) => u.email === email) || null;
    },
    async getUserById(id) {
      return pick(db.users.find((u) => u.id === id)) || null;
    },
    async deleteUser(id) {
      db.users = db.users.filter((u) => u.id !== id);
      db.reports = db.reports.filter((r) => r.user_id !== id);
      save();
    },

    async saveReport(r) {
      db.reports.push({
        id: r.id, user_id: r.userId, claim_token: r.claimToken, input: r.input, report: r.report,
        model: r.model, cached: r.cached, input_tokens: r.inputTokens, output_tokens: r.outputTokens,
        created_at: now(),
      });
      save();
    },
    async listReports(userId) {
      return db.reports
        .filter((r) => r.user_id === userId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 100)
        .map((r) => ({
          id: r.id, created_at: r.created_at,
          occasion: r.input && r.input.occasion, style: r.input && r.input.style, tovch: r.report.tovch,
        }));
    },
    async getReport(id, userId) {
      const r = db.reports.find((x) => x.id === id && x.user_id === userId);
      return r ? { id: r.id, created_at: r.created_at, input: r.input, report: r.report } : null;
    },
    async claimReport(claimToken, userId) {
      const r = db.reports.find((x) => x.claim_token === claimToken && !x.user_id);
      if (!r) return null;
      r.user_id = userId;
      r.claim_token = null;
      save();
      return r.id;
    },

    async incrUsage(key, delta) {
      db.usage[key] = (db.usage[key] || 0) + delta;
      save();
      return db.usage[key];
    },
    async getUsage(key) {
      return db.usage[key] || 0;
    },

    async getCache(key) {
      return db.cache[key] || null;
    },
    async setCache(key, report) {
      if (!db.cache[key]) db.cache[key] = report;
      save();
    },

    async logEvent(name, userId, meta) {
      db.events.push({ name, user_id: userId, meta: meta || null, created_at: now() });
      save();
    },

    async stats(sinceDay) {
      const week = new Date(Date.now() - 7 * 864e5).toISOString();
      const sum = (arr, f) => arr.reduce((s, r) => s + (r[f] || 0), 0);
      const perUser = {};
      db.reports.forEach((r) => { if (r.user_id) perUser[r.user_id] = (perUser[r.user_id] || 0) + 1; });
      const byModel = {};
      db.reports.forEach((r) => {
        const m = (byModel[r.model] = byModel[r.model] || { model: r.model, input_tokens: 0, output_tokens: 0 });
        m.input_tokens += r.input_tokens || 0;
        m.output_tokens += r.output_tokens || 0;
      });
      const events = {};
      db.events.forEach((e) => { events[e.name] = (events[e.name] || 0) + 1; });
      return {
        users: db.users.length,
        reports: {
          total: db.reports.length,
          today: db.reports.filter((r) => r.created_at >= sinceDay).length,
          last7d: db.reports.filter((r) => r.created_at >= week).length,
          cached: db.reports.filter((r) => r.cached).length,
          input_tokens: sum(db.reports, "input_tokens"),
          output_tokens: sum(db.reports, "output_tokens"),
        },
        returningUsers: Object.values(perUser).filter((n) => n >= 2).length,
        byModel: Object.values(byModel),
        events: Object.entries(events).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
      };
    },
  };
}

module.exports = { createFileStore };
