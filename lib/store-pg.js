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
`;

function createPgStore(connectionString) {
  const pool = new Pool({ connectionString, max: 3 });
  let ready;
  const q = async (text, params) => {
    ready = ready || pool.query(SCHEMA);
    await ready;
    return pool.query(text, params);
  };

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
      return (await q("select id,email,created_at from users where id=$1", [id])).rows[0] || null;
    },
    async deleteUser(id) {
      await q("delete from users where id=$1", [id]);
    },

    async saveReport(r) {
      await q(
        `insert into reports(id,user_id,claim_token,input,report,model,cached,input_tokens,output_tokens)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.id, r.userId, r.claimToken, r.input, r.report, r.model, r.cached, r.inputTokens, r.outputTokens]
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

    async logEvent(name, userId, meta) {
      await q("insert into events(name,user_id,meta) values($1,$2,$3)", [name, userId, meta || null]);
    },

    async stats(sinceDay) {
      const one = async (sql, p) => (await q(sql, p)).rows[0];
      const users = await one("select count(*)::int as n from users");
      const reports = await one(
        `select count(*)::int as total,
                count(*) filter (where created_at >= $1)::int as today,
                count(*) filter (where created_at >= now() - interval '7 days')::int as last7d,
                count(*) filter (where cached)::int as cached,
                coalesce(sum(input_tokens),0)::bigint as input_tokens,
                coalesce(sum(output_tokens),0)::bigint as output_tokens
         from reports`,
        [sinceDay]
      );
      const returning = await one(
        "select count(*)::int as n from (select user_id from reports where user_id is not null group by user_id having count(*)>=2) t"
      );
      const byModel = (await q(
        "select model, coalesce(sum(input_tokens),0)::bigint as input_tokens, coalesce(sum(output_tokens),0)::bigint as output_tokens from reports group by model"
      )).rows;
      const events = (await q("select name, count(*)::int as n from events group by name order by n desc")).rows;
      // bigint-ийг pg string болгож буцаадаг
      reports.input_tokens = Number(reports.input_tokens);
      reports.output_tokens = Number(reports.output_tokens);
      byModel.forEach((m) => { m.input_tokens = Number(m.input_tokens); m.output_tokens = Number(m.output_tokens); });
      return { users: users.n, reports, returningUsers: returning.n, byModel, events };
    },
  };
}

module.exports = { createPgStore };
