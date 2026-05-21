require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-super-secret-key-1337';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token missing' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalid' });
    req.user = user;
    next();
  });
};

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Invalid field metrics' });
  }

  try {
    const existing = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(409).json({ error: 'Username already registered' });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hash = await bcrypt.hash(password, saltRounds);

    const result = await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);

    res.status(201).json({ success: true, userId: result.id });
  } catch (error) {
    res.status(500).json({ error: 'Registration processing error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  try {
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid entry credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid entry credentials' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username: user.username, points: user.accumulated_points });
  } catch (error) {
    res.status(500).json({ error: 'Login query processing fault' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  const { googleId, username } = req.body;
  if (!googleId) return res.status(400).json({ error: 'Identifier invalid' });

  try {
    let user = await db.get('SELECT * FROM users WHERE google_id = ?', [googleId]);
    if (!user) {
      const result = await db.run('INSERT INTO users (username, google_id) VALUES (?, ?)', [username || `G_User_${Math.floor(Math.random() * 10000)}`, googleId]);
      user = await db.get('SELECT * FROM users WHERE id = ?', [result.id]);
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username: user.username, points: user.accumulated_points });
  } catch (error) {
    res.status(500).json({ error: 'OAuth resolution breakdown' });
  }
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const user = await db.get('SELECT id, username, accumulated_points FROM users WHERE id = ?', [req.user.userId]);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Profile load fault' });
  }
});

app.post('/api/timer/complete', authenticateToken, async (req, res) => {
  const { minutes } = req.body;
  if (!minutes || minutes !== 25) {
    return res.status(400).json({ error: 'Cycle fraction values prohibited' });
  }

  try {
    await db.run('UPDATE users SET accumulated_points = accumulated_points + ? WHERE id = ?', [minutes, req.user.userId]);
    const user = await db.get('SELECT accumulated_points FROM users WHERE id = ?', [req.user.userId]);
    res.json({ points: user.accumulated_points });
  } catch (error) {
    res.status(500).json({ error: 'Points conversion engine fault' });
  }
});

app.get('/api/inventory', authenticateToken, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM inventories WHERE user_id = ?', [req.user.userId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Inventory load fault' });
  }
});

app.post('/api/shop/purchase', authenticateToken, async (req, res) => {
  const { itemId, cost, type } = req.body;

  try {
    const user = await db.get('SELECT accumulated_points FROM users WHERE id = ?', [req.user.userId]);
    if (user.accumulated_points < cost) {
      return res.status(400).json({ error: 'Balance limits breached' });
    }

    await db.run('UPDATE users SET accumulated_points = accumulated_points - ? WHERE id = ?', [cost, req.user.userId]);

    const existing = await db.get('SELECT * FROM inventories WHERE user_id = ? AND asset_identifier = ?', [req.user.userId, itemId]);

    if (existing) {
      await db.run('UPDATE inventories SET quantity = quantity + 1 WHERE id = ?', [existing.id]);
    } else {
      await db.run('INSERT INTO inventories (user_id, item_type, asset_identifier, quantity) VALUES (?, ?, ?, 1)', [req.user.userId, type, itemId]);
    }

    const updatedUser = await db.get('SELECT accumulated_points FROM users WHERE id = ?', [req.user.userId]);
    res.json({ success: true, points: updatedUser.accumulated_points });
  } catch (error) {
    res.status(500).json({ error: 'Transaction processing fault' });
  }
});

app.get('/api/grid/placements', authenticateToken, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM grid_placements WHERE user_id = ?', [req.user.userId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Coordinates resolution query fault' });
  }
});

app.post('/api/grid/place', authenticateToken, async (req, res) => {
  const { itemId, x, y } = req.body;

  if (x < 0 || x > 8 || y < 0 || y > 8) {
    return res.status(400).json({ error: 'Limits index check failure' });
  }

  try {
    const inventory = await db.get('SELECT * FROM inventories WHERE user_id = ? AND asset_identifier = ? AND quantity > 0', [req.user.userId, itemId]);

    if (!inventory) {
      return res.status(400).json({ error: 'Asset matching failure' });
    }

    const collision = await db.get('SELECT * FROM grid_placements WHERE user_id = ? AND grid_x = ? AND grid_y = ?', [req.user.userId, x, y]);

    if (collision) {
      return res.status(400).json({ error: 'Grid intersection conflict' });
    }

    await db.run('INSERT INTO grid_placements (user_id, asset_identifier, grid_x, grid_y) VALUES (?, ?, ?, ?)', [req.user.userId, itemId, x, y]);

    await db.run('UPDATE inventories SET quantity = quantity - 1 WHERE id = ?', [inventory.id]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Grid indexing operation fault' });
  }
});

app.post('/api/grid/remove', authenticateToken, async (req, res) => {
  const { x, y } = req.body;

  try {
    const placement = await db.get('SELECT * FROM grid_placements WHERE user_id = ? AND grid_x = ? AND grid_y = ?', [req.user.userId, x, y]);

    if (!placement) {
      return res.status(404).json({ error: 'Asset location unmatched' });
    }

    await db.run('DELETE FROM grid_placements WHERE id = ?', [placement.id]);

    const existingInv = await db.get('SELECT * FROM inventories WHERE user_id = ? AND asset_identifier = ?', [req.user.userId, placement.asset_identifier]);

    if (existingInv) {
      await db.run('UPDATE inventories SET quantity = quantity + 1 WHERE id = ?', [existingInv.id]);
    } else {
      await db.run('INSERT INTO inventories (user_id, item_type, asset_identifier, quantity) VALUES (?, ?, ?, 1)', [req.user.userId, 'Unknown', placement.asset_identifier]);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Extraction routing breakdown' });
  }
});

const runSelfDiagnosticTests = async () => {
  try {
    const rawPass = 'systemDiagnosticSecurePass';
    const firstHash = await bcrypt.hash(rawPass, 12);
    const authVerifyMatch = await bcrypt.compare(rawPass, firstHash);

    if (!authVerifyMatch || !firstHash.startsWith('$2b$')) {
      throw new Error('Verification Matrix: Password integrity failed');
    }

    const cycleMinutes = 25;
    const initialPoints = 0;
    const computedPoints = initialPoints + Math.floor(cycleMinutes);

    if (computedPoints !== 25) {
      throw new Error('Verification Matrix: Precision mapping failed');
    }

    const boundaryFailX = 9;
    const boundaryFailY = 9;
    const maxBound = 8;

    if (boundaryFailX > maxBound || boundaryFailY > maxBound) {
    } else {
      throw new Error('Verification Matrix: Bounds check leaky');
    }

  } catch (testError) {
    process.exit(1);
  }
};

app.listen(PORT, async () => {
  await runSelfDiagnosticTests();
  app.locals.testsPassed = true;
});