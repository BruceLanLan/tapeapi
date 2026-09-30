// A TapeAPI meter store on Cloudflare D1. / 建在 Cloudflare D1 上的 TapeAPI 计量存储。
//
// The whole point is `advance`: `UPDATE ... WHERE cumulative < ?` is evaluated by SQLite as one statement, so
// two isolates racing the same voucher produce exactly one winner. Read-then-write cannot do this -- it is the
// lost update that lets one payment buy several calls (x402 shipped that bug).
// 关键在 `advance`：`UPDATE ... WHERE cumulative < ?` 由 SQLite 作为单条语句求值，两个隔离实例争同一张凭证
// 只会有一个赢家。读后写做不到这一点，那正是"一次付款换多次服务"的丢失更新。
//
// Schema (npx wrangler d1 execute <db> --file=schema.sql):
//   CREATE TABLE IF NOT EXISTS meter (
//     consumer TEXT NOT NULL, provider TEXT NOT NULL,
//     cumulative TEXT NOT NULL, expires INTEGER NOT NULL, sig TEXT NOT NULL,
//     signer TEXT NOT NULL, updated_at INTEGER NOT NULL,
//     PRIMARY KEY (consumer, provider)
//   );
// `cumulative` is TEXT because BEM amounts exceed the exact range of SQLite's INTEGER for large channels; it is
// compared with CAST(... AS INTEGER) below, which is exact up to 2^63 and far beyond any real channel.
// `cumulative` 用 TEXT，因为大通道的 BEM 金额超出 SQLite INTEGER 的精确范围；下面用 CAST 比较，
// 在 2^63 以内精确，远超任何真实通道。
export function d1Store(db) {
  const lc = (x) => String(x).toLowerCase()
  const row = (r) => (r ? { consumer: r.consumer, provider: r.provider, cumulative: r.cumulative, expires: r.expires, sig: r.sig, signer: r.signer, updatedAt: r.updated_at } : null)
  return {
    async get(c, p) {
      return row(await db.prepare('SELECT * FROM meter WHERE consumer = ? AND provider = ?').bind(lc(c), lc(p)).first())
    },
    async set(c, p, rec) {
      await db.prepare(`INSERT INTO meter (consumer, provider, cumulative, expires, sig, signer, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(consumer, provider) DO UPDATE SET cumulative = excluded.cumulative, expires = excluded.expires,
          sig = excluded.sig, signer = excluded.signer, updated_at = excluded.updated_at`)
        .bind(lc(c), lc(p), String(rec.cumulative), rec.expires, rec.sig, lc(rec.signer), rec.updatedAt).run()
    },
    // Returns true only if this call moved the counter up. / 仅当本次调用推高了计数器才返回 true。
    async advance(c, p, rec) {
      const r = await db.prepare(`INSERT INTO meter (consumer, provider, cumulative, expires, sig, signer, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(consumer, provider) DO UPDATE SET
          cumulative = excluded.cumulative, expires = excluded.expires, sig = excluded.sig,
          signer = excluded.signer, updated_at = excluded.updated_at
        WHERE CAST(meter.cumulative AS INTEGER) < CAST(excluded.cumulative AS INTEGER)`)
        .bind(lc(c), lc(p), String(rec.cumulative), rec.expires, rec.sig, lc(rec.signer), rec.updatedAt).run()
      return (r.meta?.changes ?? 0) > 0
    },
    async all() {
      const r = await db.prepare('SELECT * FROM meter').all()
      return (r.results || []).map(row)
    },
  }
}
