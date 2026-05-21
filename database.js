const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'pomodoro.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username VARCHAR(50) UNIQUE,
      password_hash VARCHAR(255),
      google_id VARCHAR(255),
      accumulated_points INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT REFERENCES users(id),
      item_type VARCHAR(50),
      asset_identifier VARCHAR(100),
      quantity INT DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS grid_placements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT REFERENCES users(id),
      asset_identifier VARCHAR(100),
      grid_x INT CHECK (grid_x BETWEEN 0 AND 8),
      grid_y INT CHECK (grid_y BETWEEN 0 AND 8)
    )
  `);
});

module.exports = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes
                });
            });
        });
    },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
            });
        });
    },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
            });
        });
    }
};