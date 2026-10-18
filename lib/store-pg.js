// Postgres store — production (Neon, Supabase, Vercel Postgres гэх мэт).
// DATABASE_URL-д sslmode=require байвал pg өөрөө SSL ашиглана.

const { Pool } = require("pg");

const SCHEMA = `
create table if not exists users(
  id text primary key,
  email text unique not null,
  pass_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists reports(
  id text primary key,
  user_id text references users(id) on delete cascade,
  claim_token text,
  input jsonb,
  report jsonb not null,
  model text,
  cached boolean not null default false,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists reports_user_idx on reports(user_id, created_at desc);
create index if not exists reports_claim_idx on reports(claim_token) where claim_token is not null;
create table if not exists quota_usage(
  key text primary key,
  count int not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists report_cache(
  key text primary key,
  report jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists events(
  id bigserial primary key,
  name text not null,
  user_id text,
  meta jsonb,
  created_at timestamptz not null default now()
);

-- Multi-tenant: дэлгүүр, роль, store_id
create table if not exists stores(
  id text primary key,
  slug text unique not null,
  name text not null,
  accent text,
  active boolean not null default true,
  daily_cap int,
  created_at timestamptz not null default now()
);
alter table users add column if not exists role text not null default 'USER';
alter table users add column if not exists store_id text references stores(id) on delete set null;
alter table reports add column if not exists store_id text references stores(id) on delete set null;
alter table events add column if not exists store_id text references stores(id) on delete set null;
create index if not exists reports_store_idx on reports(store_id, created_at desc);
`;

function createPgStore(connectionString) {
  const pool = new Pool({ connectionString, max: 3 });
  // Олон serverless instance зэрэг асахад schema давхар үүсэхээс advisory lock-оор хамгаална
  async function migrate() {
    const c = await pool.connect();
    try {
      await c.query("select pg_advisory_lock(727001)");
      await c.query(SCHEMA);
    } finally {
      await c.query("select pg_advisory_unlock(727001)").catch(() => {});
      c.release();
    }
  }
  let ready;
  const q = async (text, params) => {
    ready = ready || migrate().catch((e) => { ready = null; throw e; });
    await ready;
    return pool.query(text, params);
  };
  const STORE_COLS = "id,slug,name,accent,active,daily_cap,created_at";

  return {
    kind: "postgres",
    close: () => pool.end(),

    async createUser(id, email, passHash) {
      const r = await q(
        "insert into users(id,email,pass_hash) values($1,$2,$3) on conflict(email) do nothing returning id,email,created_at",
        [id, email, passHash]
      );
      return r.rows[0] || null;
    },
    async getUserByEmail(email) {
      return (await q("select * from users where email=$1", [email])).rows[0] || null;
    },
    async getUserById(id) {
      return (await q("select id,email,role,store_id,created_at from users where id=$1", [id])).rows[0] || null;
    },
    async setUserRole(id, role, storeId) {
      const r = await q("update users set role=$2, store_id=$3 where id=$1 returning id,email,role,store_id", [id, role, storeId]);
      return r.rows[0] || null;
    },
    async deleteUser(id) {
      await q("delete from users where id=$1", [id]);
    },

    async saveReport(r) {
      await q(
        `insert into reports(id,user_id,claim_token,input,report,model,cached,input_tokens,output_tokens,store_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.id, r.userId, r.claimToken, r.input, r.report, r.model, r.cached, r.inputTokens, r.outputTokens, r.storeId || null]
      );
    },
    async listReports(userId) {
      const r = await q(
        `select id, created_at, input->>'occasion' as occasion, input->>'style' as style, report->>'tovch' as tovch
         from reports where user_id=$1 order by created_at desc limit 100`,
        [userId]
      );
      return r.rows;
    },
    async getReport(id, userId) {
      const r = await q("select id,created_at,input,report from reports where id=$1 and user_id=$2", [id, userId]);
      return r.rows[0] || null;
    },
    async getLastInput(userId) {
      const r = await q("select input from reports where user_id=$1 order by created_at desc limit 1", [userId]);
      return r.rows[0] ? r.rows[0].input : null;
    },
    async claimReport(claimToken, userId) {
      const r = await q(
        "update reports set user_id=$1, claim_token=null where claim_token=$2 and user_id is null returning id",
        [userId, claimToken]
      );
      return r.rows[0] ? r.rows[0].id : null;
    },

    async incrUsage(key, delta) {
      const r = await q(
        `insert into quota_usage(key,count) values($1,$2)
         on conflict(key) do update set count=quota_usage.count+$2, updated_at=now() returning count`,
        [key, delta]
      );
      return r.rows[0].count;
    },
    async getUsage(key) {
      const r = await q("select count from quota_usage where key=$1", [key]);
      return r.rows[0] ? r.rows[0].count : 0;
    },

    async getCache(key) {
      const r = await q("select report from report_cache where key=$1", [key]);
      return r.rows[0] ? r.rows[0].report : null;
    },
    async setCache(key, report) {
      await q("insert into report_cache(key,report) values($1,$2) on conflict(key) do nothing", [key, report]);
    },

    async logEvent(name, userId, meta, storeId) {
      await q("insert into events(name,user_id,meta,store_id) values($1,$2,$3,$4)", [name, userId, meta || null, storeId || null]);
    },

    async createStoreRow(s) {
      const r = await q(
        `insert into stores(id,slug,name,accent,daily_cap) values($1,$2,$3,$4,$5)
         on conflict(slug) do nothing returning ${STORE_COLS}`,
        [s.id, s.slug, s.name, s.accent || null, s.dailyCap == null ? null : s.dailyCap]
      );
      return r.rows[0] || null;
    },
    async getStoreBySlug(slug) {
      return (await q(`select ${STORE_COLS} from stores where slug=$1`, [slug])).rows[0] || null;
    },
    async getStoreById(id) {
      return (await q(`select ${STORE_COLS} from stores where id=$1`, [id])).rows[0] || null;
    },
    async listStores() {
      const r = await q(
        `select s.id,s.slug,s.name,s.accent,s.active,s.daily_cap,s.created_at,
                (select count(*)::int from reports r where r.store_id=s.id) as reports,
                (select count(*)::int from users u where u.store_id=s.id and u.role='STORE_ADMIN') as admins
         from stores s order by s.created_at desc`
      );
      return r.rows;
    },
    async updateStore(id, f) {
      const r = await q(
        `update stores set name=coalesce($2,name), accent=coalesce($3,accent), active=coalesce($4,active),
                daily_cap=case when $5::boolean then $6::int else daily_cap end
         where id=$1 returning ${STORE_COLS}`,
        [id, f.name ?? null, f.accent ?? null, f.active ?? null, "dailyCap" in f, f.dailyCap ?? null]
      );
      return r.rows[0] || null;
    },
    async listStoreAdmins(storeId) {
      return (await q("select id,email from users where store_id=$1 and role='STORE_ADMIN' order by email", [storeId])).rows;
    },

    // storeId өгвөл зөвхөн тухайн дэлгүүрийн тоо (STORE_ADMIN-д). Хувь хүний тайлан биш, нийлбэр л буцаана.
    async stats(sinceDay, storeId = null) {
      const one = async (sql, p) => (await q(sql, p)).rows[0];
      const sf = storeId ? "store_id=$2" : "true";
      const p2 = storeId ? [sinceDay, storeId] : [sinceDay];
      const users = storeId
        ? await one("select count(distinct user_id)::int as n from reports where user_id is not null and store_id=$1", [storeId])
        : await one("select count(*)::int as n from users");
      const reports = await one(
        `select count(*)::int as total,
                count(*) filter (where created_at >= $1)::int as today,
                count(*) filter (where created_at >= now() - interval '7 days')::int as last7d,
                count(*) filter (where cached)::int as cached,
                coalesce(sum(input_tokens),0)::bigint as input_tokens,
                coalesce(sum(output_tokens),0)::bigint as output_tokens
         from reports where ${sf}`,
        p2
      );
      const returning = await one(
        `select count(*)::int as n from (select user_id from reports where user_id is not null and ${sf.replace("$2", "$1")}
         group by user_id having count(*)>=2) t`,
        storeId ? [storeId] : []
      );
      const byModel = (await q(
        `select model, coalesce(sum(input_tokens),0)::bigint as input_tokens, coalesce(sum(output_tokens),0)::bigint as output_tokens
         from reports where ${sf.replace("$2", "$1")} group by model`,
        storeId ? [storeId] : []
      )).rows;
      const events = (await q(
        `select name, count(*)::int as n from events where ${sf.replace("$2", "$1")} group by name order by n desc`,
        storeId ? [storeId] : []
      )).rows;
      // bigint-ийг pg string болгож буцаадаг
      reports.input_tokens = Number(reports.input_tokens);
      reports.output_tokens = Number(reports.output_tokens);
      byModel.forEach((m) => { m.input_tokens = Number(m.input_tokens); m.output_tokens = Number(m.output_tokens); });
      return { users: users.n, reports, returningUsers: returning.n, byModel, events };
    },
  };
}

module.exports = { createPgStore };
