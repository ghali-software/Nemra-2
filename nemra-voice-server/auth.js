import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import db from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const JWT_EXPIRES = "24h";

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifie" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Token invalide ou expire" });
  req.user = payload;
  next();
}

export function hasRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Non authentifie" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Acces refuse" });
    next();
  };
}

export function generatePassword() {
  return crypto.randomBytes(4).toString("hex");
}

export function seedAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get("admin@nemra.ma");
  if (existing) return null;
  const password = "admin123";
  const hash = hashPassword(password);
  db.prepare(
    "INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES (?, ?, ?, ?, ?)"
  ).run("admin@nemra.ma", hash, "Admin", "Nemra", "admin");
  return password;
}
