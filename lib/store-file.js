// JSON файл store — зөвхөн локал хөгжүүлэлт, тестэд. Vercel дээр файл хадгалагдахгүй.
// Postgres store-той ижил интерфэйстэй.

const fs = require("fs");
const path = require("path");

function createFileStore(file) {
  let db = { users: [], reports: [], usage: {}, cache: {}, events: [], stores: [] };
  if (file && fs.existsSync(file)) db = { ...db, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  // Postgres-ийн адил: store_admins анх үүсэхэд хуучин STORE_ADMIN + store_id-г OWNER болгон нэг удаа хуулна
  if (!db.store_admins) {
    db.store_admins = db.users.filter((u) => u.role === "STORE_ADMIN" && u.store_id)
      .map((u) => ({ store_id: u.store_id, user_id: u.id, level: "OWNER", created_at: u.created_at }));
  }

  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db));
  };
  const now = () => new Date().toISOString();
  const pick = (u) => u && { id: u.id, email: u.email, role: u.role || "USER", store_id: u.store_id || null, created_at: u.created_at };
  const storeRow = (s) => s && { ...s };

  return {
    kind: "file",

    async createUser(id, email, passHash) {
      if (db.users.some((u) => u.email === email)) return null;
      const u = { id, email, pass_hash: passHash, role: "USER", store_id: null, created_at: now() };
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
    async setUserRole(id, role) {
      const u = db.users.find((x) => x.id === id);
      if (!u) return null;
      u.role = role;
      save();
      return { id: u.id, email: u.email, role: u.role };
    },
    async deleteUser(id) {
      db.users = db.users.filter((u) => u.id !== id);
      db.reports = db.reports.filter((r) => r.user_id !== id);
      db.store_admins = db.store_admins.filter((a) => a.user_id !== id);
      save();
    },

    async saveReport(r) {
      db.reports.push({
        id: r.id, user_id: r.userId, claim_token: r.claimToken, input: r.input, report: r.report,
        model: r.model, cached: r.cached, input_tokens: r.inputTokens, output_tokens: r.outputTokens,
        store_id: r.storeId || null, created_at: now(),
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
    async getLastInput(userId) {
      const mine = db.reports.filter((x) => x.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return mine.length ? mine[0].input : null;
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

    async logEvent(name, userId, meta, storeId) {
      db.events.push({ name, user_id: userId, meta: meta || null, store_id: storeId || null, created_at: now() });
      save();
    },

    async createStoreRow(s) {
      if (db.stores.some((x) => x.slug === s.slug)) return null;
      const row = {
        id: s.id, slug: s.slug, name: s.name, accent: s.accent || null, active: true,
        daily_cap: s.dailyCap == null ? null : s.dailyCap, created_at: now(),
      };
      db.stores.push(row);
      save();
      return storeRow(row);
    },
    async getStoreBySlug(slug) {
      return storeRow(db.stores.find((x) => x.slug === slug)) || null;
    },
    async getStoreById(id) {
      return storeRow(db.stores.find((x) => x.id === id)) || null;
    },
    async listStores() {
      return db.stores.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).map((s) => ({
        ...s,
        reports: db.reports.filter((r) => r.store_id === s.id).length,
        admins: db.store_admins.filter((a) => a.store_id === s.id).length,
      }));
    },
    async updateStore(id, f) {
      const s = db.stores.find((x) => x.id === id);
      if (!s) return null;
      ["name", "accent", "active"].forEach((k) => { if (f[k] != null) s[k] = f[k]; });
      if ("dailyCap" in f) s.daily_cap = f.dailyCap;
      save();
      return storeRow(s);
    },
    async listStoreAdmins(storeId) {
      return db.store_admins.filter((a) => a.store_id === storeId)
        .map((a) => ({ id: a.user_id, email: (db.users.find((u) => u.id === a.user_id) || {}).email, level: a.level }))
        .sort((a, b) => (a.level === b.level ? a.email.localeCompare(b.email) : a.level === "OWNER" ? -1 : 1));
    },
    async listUserStores(userId) {
      return db.store_admins.filter((a) => a.user_id === userId)
        .map((a) => ({ ...storeRow(db.stores.find((s) => s.id === a.store_id)), level: a.level }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async getStoreLevel(storeId, userId) {
      const a = db.store_admins.find((x) => x.store_id === storeId && x.user_id === userId);
      return a ? a.level : null;
    },
    async setStoreAdmin(storeId, userId, level) {
      let a = db.store_admins.find((x) => x.store_id === storeId && x.user_id === userId);
      if (a) a.level = level;
      else db.store_admins.push((a = { store_id: storeId, user_id: userId, level, created_at: now() }));
      save();
      return { store_id: a.store_id, user_id: a.user_id, level: a.level };
    },
    async removeStoreAdmin(storeId, userId) {
      const before = db.store_admins.length;
      db.store_admins = db.store_admins.filter((x) => !(x.store_id === storeId && x.user_id === userId));
      save();
      return db.store_admins.length < before;
    },
    async countStoreOwners(storeId) {
      return db.store_admins.filter((x) => x.store_id === storeId && x.level === "OWNER").length;
    },

    async stats(sinceDay, storeIds = null) {
      const scoped = Array.isArray(storeIds);
      const reportsAll = scoped ? db.reports.filter((r) => storeIds.includes(r.store_id)) : db.reports;
      const eventsAll = scoped ? db.events.filter((e) => storeIds.includes(e.store_id)) : db.events;
      const week = new Date(Date.now() - 7 * 864e5).toISOString();
      const sum = (arr, f) => arr.reduce((s, r) => s + (r[f] || 0), 0);
      const perUser = {};
      reportsAll.forEach((r) => { if (r.user_id) perUser[r.user_id] = (perUser[r.user_id] || 0) + 1; });
      const byModel = {};
      reportsAll.forEach((r) => {
        const m = (byModel[r.model] = byModel[r.model] || { model: r.model, input_tokens: 0, output_tokens: 0 });
        m.input_tokens += r.input_tokens || 0;
        m.output_tokens += r.output_tokens || 0;
      });
      const events = {};
      eventsAll.forEach((e) => { events[e.name] = (events[e.name] || 0) + 1; });
      return {
        users: scoped ? new Set(reportsAll.filter((r) => r.user_id).map((r) => r.user_id)).size : db.users.length,
        reports: {
          total: reportsAll.length,
          today: reportsAll.filter((r) => r.created_at >= sinceDay).length,
          last7d: reportsAll.filter((r) => r.created_at >= week).length,
          cached: reportsAll.filter((r) => r.cached).length,
          input_tokens: sum(reportsAll, "input_tokens"),
          output_tokens: sum(reportsAll, "output_tokens"),
        },
        returningUsers: Object.values(perUser).filter((n) => n >= 2).length,
        byModel: Object.values(byModel),
        events: Object.entries(events).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
      };
    },
  };
}

module.exports = { createFileStore };
