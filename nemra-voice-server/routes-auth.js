import { Router } from "express";
import db from "./db.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  generatePassword,
  requireAuth,
  hasRole,
} from "./auth.js";

const router = Router();

// ── Login ──
router.post("/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

  const user = db.prepare("SELECT * FROM users WHERE email = ? AND is_active = 1").get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });
  }

  const token = generateToken(user);
  res.json({
    token,
    user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role },
  });
});

// ── Logout (stateless — côté client) ──
router.post("/auth/logout", (_req, res) => {
  res.json({ ok: true });
});

// ── Me ──
router.get("/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, first_name, last_name, role, personal_phone FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role, phone: user.personal_phone });
});

// ── CRUD Users (admin only) ──

// List
router.get("/users", requireAuth, hasRole("admin", "supervisor"), (_req, res) => {
  const users = db.prepare(
    "SELECT id, email, first_name, last_name, role, personal_phone, is_active, created_at FROM users ORDER BY created_at DESC"
  ).all();
  res.json(users);
});

// Create
router.post("/users", requireAuth, hasRole("admin"), (req, res) => {
  const { email, firstName, lastName, role, phone } = req.body || {};
  if (!email || !firstName) return res.status(400).json({ error: "Email et prenom requis" });
  if (role && !["agent", "supervisor", "admin"].includes(role)) return res.status(400).json({ error: "Role invalide" });

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "Email deja utilise" });

  const password = generatePassword();
  const hash = hashPassword(password);

  const result = db.prepare(
    "INSERT INTO users (email, password_hash, first_name, last_name, role, personal_phone) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(email, hash, firstName, lastName || "", role || "agent", phone || "");

  res.json({
    id: result.lastInsertRowid,
    email,
    firstName,
    lastName: lastName || "",
    role: role || "agent",
    generatedPassword: password,
  });
});

// Update
router.put("/users/:id", requireAuth, hasRole("admin"), (req, res) => {
  const { id } = req.params;
  const { email, firstName, lastName, role, phone } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

  db.prepare(
    "UPDATE users SET email = ?, first_name = ?, last_name = ?, role = ?, personal_phone = ? WHERE id = ?"
  ).run(
    email || user.email,
    firstName ?? user.first_name,
    lastName ?? user.last_name,
    role || user.role,
    phone ?? user.personal_phone,
    id
  );
  res.json({ ok: true });
});

// Delete (soft)
router.delete("/users/:id", requireAuth, hasRole("admin"), (req, res) => {
  const { id } = req.params;
  db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(id);
  res.json({ ok: true });
});

// Reset password
router.post("/users/:id/reset-password", requireAuth, hasRole("admin"), (req, res) => {
  const { id } = req.params;
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  const password = generatePassword();
  const hash = hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
  res.json({ generatedPassword: password });
});

export default router;
