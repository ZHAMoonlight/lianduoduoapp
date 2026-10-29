import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeVenueName } = require('../.local-runtime/lib/venues.js');
const keyOf = (tenantId, storeId, name) => JSON.stringify([tenantId, storeId, normalizeVenueName(name)]);

/** Link genuine historical room names without changing any display snapshot or ledger. */
export async function backfillVenueCatalog(database, now = new Date()) {
  return database.transaction(async () => {
    const rows = await database.prepare('SELECT data FROM venues ORDER BY seq').all();
    const venues = new Map(rows.map(row => { const venue = JSON.parse(row.data); return [keyOf(venue.tenantId, venue.storeId, venue.name), venue]; }));
    const added = new Map(), changedVenues = new Map(), updates = [];
    const stamp = now.toISOString();
    const classRows = await database.prepare('SELECT id,data FROM classes ORDER BY seq').all();
    const classRecords = classRows.map(row => JSON.parse(row.data));
    const hasFutureParallelClasses = planId => {
      const occupied = classRecords.filter(cls => cls.schedulePlanId === planId && cls.status === 'scheduled' && Date.parse(cls.endAt) > now.getTime());
      return occupied.some((first, index) => occupied.slice(index + 1).some(second => first.coachId !== second.coachId && Date.parse(first.startAt) < Date.parse(second.endAt) && Date.parse(second.startAt) < Date.parse(first.endAt)));
    };
    let classes = 0, plans = 0;
    for (const table of ['classes', 'schedule_plans']) {
      const records = table === 'classes' ? classRows : await database.prepare(`SELECT id,data FROM ${table} ORDER BY seq`).all();
      for (const row of records) {
        const record = JSON.parse(row.data);
        if (record.venueId || typeof record.tenantId !== 'string' || !record.tenantId || typeof record.storeId !== 'string' || typeof record.room !== 'string' || !record.room.trim()) continue;
        const name = record.room.normalize('NFKC').trim().replace(/\s+/g, ' ');
        const key = keyOf(record.tenantId, record.storeId, name);
        let venue = venues.get(key);
        if (!venue) {
          const id = `venue-legacy-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
          venue = { id, tenantId: record.tenantId, storeId: record.storeId, name, location: '', description: '', allowShared: false, status: 'active', createdAt: stamp, updatedAt: stamp };
          venues.set(key, venue); added.set(id, venue);
        }
        if (table === 'schedule_plans' && record.sharedRoom === true && !venue.allowShared && (added.has(venue.id) || hasFutureParallelClasses(record.id))) {
          venue.allowShared = true; venue.updatedAt = stamp;
          if (!added.has(venue.id)) changedVenues.set(venue.id, venue);
        }
        updates.push({ table, id: row.id, data: JSON.stringify({ ...record, venueId: venue.id }) });
        if (table === 'classes') classes++; else plans++;
      }
    }
    for (const venue of added.values()) await database.prepare('INSERT INTO venues(id,tenant_id,store_id,data) VALUES(?,?,?,?)').run(venue.id, venue.tenantId, venue.storeId, JSON.stringify(venue));
    for (const venue of changedVenues.values()) await database.prepare('UPDATE venues SET data=? WHERE id=?').run(JSON.stringify(venue), venue.id);
    for (const row of updates) await database.prepare(`UPDATE ${row.table} SET data=? WHERE id=?`).run(row.data, row.id);
    if (updates.length || added.size || changedVenues.size) {
      const previous = Number((await database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value);
      await database.prepare("UPDATE meta SET value=? WHERE `key`='version'").run(String(previous + 1));
    }
    return { createdVenues: added.size, updatedVenues: changedVenues.size, linkedClasses: classes, linkedPlans: plans };
  });
}
