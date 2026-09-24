const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const crypto = require('crypto');

let dbPromise = open({
  filename: './database.sqlite',
  driver: sqlite3.Database
}).then(async db => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT,
      id TEXT,
      data TEXT,
      PRIMARY KEY (collection, id)
    )
  `);
  return db;
});

function generatePushId() {
  const chars = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  let id = '-O';
  for (let i = 0; i < 18; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

class Snapshot {
  constructor(data, key) {
    this._data = data;
    this.key = key;
  }
  val() { return this._data; }
  forEach(cb) {
    if (!this._data || typeof this._data !== 'object') return false;
    for (const key of Object.keys(this._data)) {
      cb(new Snapshot(this._data[key], key));
    }
    return false; // Firebase forEach returns true if aborted, false otherwise
  }
}

class Ref {
  constructor(path) {
    this.path = path.replace(/^\/|\/$/g, ''); // strip leading/trailing slashes
  }
  
  child(path) {
    return new Ref(this.path + '/' + path.replace(/^\/|\/$/g, ''));
  }
  
  push() {
    const id = generatePushId();
    const newRef = this.child(id);
    newRef.key = id;
    return newRef;
  }
  
  async once(eventType) {
    const db = await dbPromise;
    const parts = this.path.split('/');
    const collection = parts[0];
    
    if (parts.length === 1) {
      const rows = await db.all("SELECT id, data FROM records WHERE collection = ?", [collection]);
      if (rows.length === 0) return new Snapshot(null, collection);
      const result = {};
      rows.forEach(r => {
        try { result[r.id] = JSON.parse(r.data); } catch(e) {}
      });
      return new Snapshot(result, collection);
    } else if (parts.length >= 2) {
      const id = parts.slice(1).join('/'); // support nested id like collection/sub1/sub2
      const row = await db.get("SELECT data FROM records WHERE collection = ? AND id = ?", [collection, id]);
      if (row) {
        try { return new Snapshot(JSON.parse(row.data), parts[parts.length-1]); } catch(e) {}
      }
      return new Snapshot(null, parts[parts.length-1]);
    }
  }
  
  async set(data) {
    const db = await dbPromise;
    const parts = this.path.split('/');
    const collection = parts[0];
    
    if (parts.length >= 2) {
      const id = parts.slice(1).join('/');
      if (data === null) {
        await db.run("DELETE FROM records WHERE collection = ? AND id = ?", [collection, id]);
      } else {
        await db.run("INSERT OR REPLACE INTO records (collection, id, data) VALUES (?, ?, ?)", [collection, id, JSON.stringify(data)]);
      }
    } else if (parts.length === 1) {
      if (data === null) {
        await db.run("DELETE FROM records WHERE collection = ?", [collection]);
      } else if (typeof data === 'object') {
        await db.run("DELETE FROM records WHERE collection = ?", [collection]);
        for (const [key, val] of Object.entries(data)) {
          await db.run("INSERT INTO records (collection, id, data) VALUES (?, ?, ?)", [collection, key, JSON.stringify(val)]);
        }
      }
    }
  }
  
  async update(updates) {
    const db = await dbPromise;
    const parts = this.path.split('/');
    const collection = parts[0];
    
    if (this.path === '') {
      // root update: e.g. { "shopee_accounts/123": null, "shopee_accounts/456/status": "OK" }
      for (const [key, value] of Object.entries(updates)) {
        const kParts = key.split('/');
        const col = kParts[0];
        const id = kParts.slice(1).join('/');
        if (value === null) {
          await db.run("DELETE FROM records WHERE collection = ? AND id = ?", [col, id]);
        } else {
          // If updating specific field of an ID (e.g. shopee_accounts/123/orderStatus)
          // Actually, our app uses 'shopee_accounts' update with { "id1/orderStatus": val, "id1/result": val }
          // We need to merge!
          const idBase = kParts[1];
          const subField = kParts.length > 2 ? kParts.slice(2).join('.') : null; // simplified
          // For simplicity in our app, updates are usually `id/field` inside a collection ref!
        }
      }
      return;
    }
    
    if (parts.length === 1) {
      // e.g. db.ref('shopee_accounts').update({ "123": null, "456/status": "OK" })
      for (const [key, value] of Object.entries(updates)) {
        if (value === null && !key.includes('/')) {
          await db.run("DELETE FROM records WHERE collection = ? AND id = ?", [collection, key]);
        } else {
          // It could be '123' -> value object OR '123/status' -> value primitive
          const kParts = key.split('/');
          const id = kParts[0];
          const row = await db.get("SELECT data FROM records WHERE collection = ? AND id = ?", [collection, id]);
          let current = row ? JSON.parse(row.data) : {};
          
          if (kParts.length === 1) {
            Object.assign(current, value);
          } else if (kParts.length === 2) {
            current[kParts[1]] = value;
          }
          await db.run("INSERT OR REPLACE INTO records (collection, id, data) VALUES (?, ?, ?)", [collection, id, JSON.stringify(current)]);
        }
      }
    } else if (parts.length >= 2) {
      const id = parts.slice(1).join('/');
      const row = await db.get("SELECT data FROM records WHERE collection = ? AND id = ?", [collection, id]);
      let current = row ? JSON.parse(row.data) : {};
      Object.assign(current, updates);
      await db.run("INSERT OR REPLACE INTO records (collection, id, data) VALUES (?, ?, ?)", [collection, id, JSON.stringify(current)]);
    }
  }
  
  async remove() {
    const db = await dbPromise;
    const parts = this.path.split('/');
    const collection = parts[0];
    
    if (parts.length === 1) {
      await db.run("DELETE FROM records WHERE collection = ?", [collection]);
    } else if (parts.length >= 2) {
      const id = parts.slice(1).join('/');
      await db.run("DELETE FROM records WHERE collection = ? AND id = ?", [collection, id]);
    }
  }
}

module.exports = {
  ref: (path = '') => new Ref(path)
};
