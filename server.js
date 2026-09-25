require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudinary云存储配置（视频自动转MP4，解决加载转圈问题）
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.startsWith('video/');
    return {
      folder: "msc_media",
      resource_type: isVideo ? "video" : "image",
      format: isVideo ? "mp4" : undefined
    }
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// 连接Render的PostgreSQL数据库
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Session配置（适配Render线上，解决登录1秒就退出的问题）
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static('public'));
// 根地址自动跳转到登录页
app.get('/', (req, res) => {
  res.redirect('/login.html');
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 启动时自动初始化数据库+创建账号
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      media_url TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const adminExist = await pool.query(`SELECT * FROM users WHERE username='admin'`);
  if (adminExist.rows.length === 0) {
    const adminPwd = await bcrypt.hash("123456", 10);
    await pool.query(`INSERT INTO users(username,password,role) VALUES($1,$2,$3)`,
      ["admin", adminPwd, "admin"]);
  }

  const viewerExist = await pool.query(`SELECT * FROM users WHERE username='w00666666'`);
  if (viewerExist.rows.length === 0) {
    const viewerPwd = await bcrypt.hash("hwissb", 10);
    await pool.query(`INSERT INTO users(username,password,role) VALUES($1,$2,$3)`,
      ["w00666666", viewerPwd, "viewer"]);
  }
  console.log("✅ 数据库初始化完成");
}
initDB();

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const userResult = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
  if (userResult.rows.length === 0) return res.json({ ok: false, msg: "账号或密码错误" });
  const user = userResult.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (match) {
    req.session.user = { id: user.id, username: user.username, role: user.role };
    return res.json({ ok: true });
  }
  res.json({ ok: false, msg: "账号或密码错误" });
});

app.get('/me', async (req, res) => {
  if (!req.session.user) return res.json(null);
  res.json({
    username: req.session.user.username,
    role: req.session.user.role
  });
});

app.get('/media-list', async (req, res) => {
  if (!req.session.user) return res.status(401).json([]);
  let sql;
  if (req.session.user.role === "admin") {
    sql = `SELECT * FROM media ORDER BY created_at ASC`;
  } else {
    sql = `SELECT * FROM media WHERE is_active=true ORDER BY created_at ASC`;
  }
  const result = await pool.query(sql);
  res.json(result.rows);
});

app.post('/upload', upload.single('mediaFile'), async (req, res) => {
  if (!req.session.user || req.session.user.role !== "admin") return res.status(403).json({ msg: "无权限" });
 const file = req.file;
// 用浏览器上传时自带的文件MIME类型判断，不会再把视频错认成图片
const type = file.mimetype.startsWith('video/') ? "video" : "image";
  await pool.query(`INSERT INTO media(media_url,type,is_active) VALUES($1,$2,$3)`,
    [file.path, type, true]);
  res.json({ ok: true });
});

app.post('/media-toggle', async (req, res) => {
  if (!req.session.user || req.session.user.role !== "admin") return res.status(403).json({ msg: "无权限" });
  const { id, isActive } = req.body;
  await pool.query(`UPDATE media SET is_active=$1 WHERE id=$2`, [isActive, id]);
  res.json({ ok: true });
});

app.post('/media-delete', async (req, res) => {
  if (!req.session.user || req.session.user.role !== "admin") return res.status(403).json({ msg: "无权限" });
  const { id } = req.body;
  const media = await pool.query(`SELECT media_url FROM media WHERE id=$1`, [id]);
  if (media.rows.length > 0) {
    const publicId = media.rows[0].media_url.split('/').slice(-2).join('/').split('.')[0];
    await cloudinary.uploader.destroy(publicId, { resource_type: "auto" });
  }
  await pool.query(`DELETE FROM media WHERE id=$1`, [id]);
  res.json({ ok: true });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 网站已启动，端口：${PORT}`);
});
