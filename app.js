// app.js
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
// ... import middleware, route ทั้งหมดที่มีอยู่เดิมใน index.js ...

const morgan = require("morgan");
const { graphqlHTTP } = require("express-graphql");

const pool = require("./db");
const schema = require("./schema");
const root = require("./resolvers");
const { redisClient, connectRedis } = require("./cache");
const {
  hashPassword,
  verifyPassword,
  generateToken,
} = require("./auth-helpers");
const { parsePagination, parseSort } = require("./middlewares/query-parser");
const { authenticateToken, authorizeRole } = require("./middlewares/auth");

const app = express();
const v1Router = express.Router();
const v2Router = express.Router();

// =========================
// Cache helpers
// ใช้ "เลขเวอร์ชัน" แทนการลบคีย์ทีละตัว
// เมื่อข้อมูลเปลี่ยน -> เพิ่มเลขเวอร์ชัน -> คีย์แคชเดิมทั้งหมดจะถูกมองข้ามและหมดอายุเอง
// =========================
const VERSION_KEY = "students:version";

async function getStudentsCacheVersion() {
  const v = await redisClient.get(VERSION_KEY);
  return v || "0";
}

async function invalidateStudentsCache() {
  await redisClient.incr(VERSION_KEY);
  await redisClient.del("students:all"); // เผื่อมีคีย์เก่าจากขั้นตอนก่อนหน้า
}

// =========================
// Middleware
// =========================
app.use(helmet());

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  }),
);

app.use(morgan("dev"));
app.use(express.json({ limit: "10kb" }));

// =========================
// Home
// =========================
app.get("/", (req, res) => {
  res.status(200).json({
    message: "Student API พร้อมใช้งาน",
  });
});

// =========================
// GraphQL
// =========================
app.use(
  "/graphql",
  graphqlHTTP({
    schema: schema,
    rootValue: root,
    graphiql: true,
  }),
);

// ... นำ route ทั้งหมดจาก index.js เดิมมาไว้ที่นี่ (auth, students, cache) ...

// =========================
// Auth: สมัครสมาชิก
// =========================
v1Router.post("/auth/register", async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "กรุณาระบุ email และ password",
      },
    });
  }

  try {
    const passwordHash = await hashPassword(password);
    const [result] = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'student')",
      [email, passwordHash],
    );

    res.status(201).json({
      message: "สมัครสมาชิกสำเร็จ",
      data: { id: result.insertId, email, role: "student" },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: { code: "DUPLICATE_EMAIL", message: "อีเมลนี้มีอยู่ในระบบแล้ว" },
      });
    }
    next(err);
  }
});

// =========================
// Auth: เข้าสู่ระบบ
// =========================
v1Router.post("/auth/login", async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "กรุณาระบุ email และ password",
      },
    });
  }

  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (rows.length === 0) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
        },
      });
    }

    const user = rows[0];
    const isPasswordValid = await verifyPassword(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
        },
      });
    }

    const token = generateToken(user);
    res.status(200).json({ message: "เข้าสู่ระบบสำเร็จ", token });
  } catch (err) {
    next(err);
  }
});

// =========================
// Auth: ข้อมูลผู้ใช้ที่ล็อกอิน
// =========================
v1Router.get("/auth/me", authenticateToken, (req, res) => {
  res.status(200).json({ message: "สำเร็จ", data: req.user });
});

// =========================
// GET: นักศึกษาทั้งหมด (pagination + sort + filter + cache)
// =========================
v1Router.get(
  "/students",
  parsePagination,
  parseSort,
  async (req, res, next) => {
    const { major } = req.query;
    const { page, limit, offset } = req.pagination;
    const { field, order } = req.sort;

    try {
      // 1) ลองอ่านจากแคชก่อน (คีย์รวมทุกพารามิเตอร์ที่มีผลต่อผลลัพธ์)
      const version = await getStudentsCacheVersion();
      const cacheKey = `students:list:v${version}:${page}:${limit}:${field}:${order}:${major || ""}`;

      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return res.status(200).json({
          message: "สำเร็จ (จาก cache)",
          ...JSON.parse(cached),
        });
      }

      // 2) ไม่มีในแคช -> query ฐานข้อมูล
      let baseQuery = "SELECT * FROM students";
      let countQuery = "SELECT COUNT(*) AS total FROM students";
      const params = [];

      if (major) {
        baseQuery += " WHERE major = ?";
        countQuery += " WHERE major = ?";
        params.push(major);
      }

      // แทรก field/order ลง SQL ได้โดยตรงเฉพาะเพราะผ่าน allowlist ใน parseSort มาแล้ว
      // ห้ามนำรูปแบบนี้ไปใช้กับค่าจาก req อื่นที่ไม่ได้ผ่าน allowlist
      baseQuery += ` ORDER BY ${field} ${order} LIMIT ? OFFSET ?`;

      const [rows] = await pool.query(baseQuery, [...params, limit, offset]);
      const [[{ total }]] = await pool.query(countQuery, params);

      const payload = {
        data: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };

      // 3) เก็บลงแคช 60 วินาที
      await redisClient.set(cacheKey, JSON.stringify(payload), { EX: 60 });

      res.status(200).json({ message: "สำเร็จ (จากฐานข้อมูล)", ...payload });
    } catch (err) {
      next(err);
    }
  },
);

// =========================
// GET: นักศึกษารายบุคคล + courses
// ต้องอยู่ก่อน /students/:id
// =========================
v1Router.get("/students/:id/full", async (req, res, next) => {
  try {
    const [studentRows] = await pool.query(
      "SELECT * FROM students WHERE id = ?",
      [req.params.id],
    );

    if (studentRows.length === 0) {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "ไม่พบข้อมูลนักศึกษา",
        },
      });
    }

    const [courseRows] = await pool.query(
      `
      SELECT c.*
      FROM courses c
      INNER JOIN enrollments sc ON c.id = sc.course_id
      WHERE sc.student_id = ?
      `,
      [req.params.id],
    );

    res.status(200).json({
      message: "สำเร็จ",
      data: {
        ...studentRows[0],
        courses: courseRows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================
// POST: ลงทะเบียนรายวิชา (Transaction)
// =========================
v1Router.post("/students/:id/enrollments", async (req, res, next) => {
  const studentId = req.params.id;
  const { courseId } = req.body;

  if (!courseId) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "กรุณาระบุ courseId" },
    });
  }

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [courseRows] = await connection.query(
      "SELECT * FROM courses WHERE id = ? FOR UPDATE",
      [courseId],
    );

    if (courseRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        error: { code: "COURSE_NOT_FOUND", message: "ไม่พบรายวิชาที่ระบุ" },
      });
    }

    if (courseRows[0].seat_available <= 0) {
      await connection.rollback();
      return res.status(409).json({
        error: { code: "SEAT_FULL", message: "ที่นั่งเต็มแล้ว" },
      });
    }

    await connection.query(
      "INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)",
      [studentId, courseId],
    );

    await connection.query(
      "UPDATE courses SET seat_available = seat_available - 1 WHERE id = ?",
      [courseId],
    );

    await connection.commit();
    res.status(201).json({ message: "ลงทะเบียนสำเร็จ" });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("Rollback ล้มเหลว:", rollbackErr);
      }
    }

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: {
          code: "ALREADY_ENROLLED",
          message: "นิสิตลงทะเบียนรายวิชานี้ไปแล้ว",
        },
      });
    }
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

// =========================
// GET: นักศึกษารายบุคคล
// =========================
v1Router.get("/students/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM students WHERE id = ?", [
      req.params.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "ไม่พบข้อมูลนักศึกษา",
        },
      });
    }

    res.status(200).json({
      message: "สำเร็จ",
      data: rows[0],
    });
  } catch (err) {
    next(err);
  }
});

// =========================
// POST: เพิ่มนักศึกษา
// =========================
v1Router.post("/students", async (req, res, next) => {
  const { name, major, email } = req.body;

  if (!name || !major || !email) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "กรุณาระบุข้อมูลให้ครบถ้วน",
      },
    });
  }

  try {
    const [result] = await pool.query(
      `
      INSERT INTO students (name, major, email)
      VALUES (?, ?, ?)
      `,
      [name, major, email],
    );

    await invalidateStudentsCache(); // ล้างแคชเนื่องจากข้อมูลเปลี่ยนแปลงแล้ว

    res.status(201).json({
      message: "เพิ่มข้อมูลสำเร็จ",
      data: {
        id: result.insertId,
        name,
        major,
        email,
      },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: {
          code: "DUPLICATE_EMAIL",
          message: "อีเมลนี้มีอยู่ในระบบแล้ว",
        },
      });
    }

    next(err);
  }
});

// =========================
// PUT: แก้ไขข้อมูลทั้งระเบียน
// =========================
v1Router.put("/students/:id", async (req, res, next) => {
  const { name, major, email } = req.body;

  if (!name || !major || !email) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "กรุณาระบุ name, major และ email ให้ครบถ้วน",
      },
    });
  }

  try {
    const [result] = await pool.query(
      `
      UPDATE students
      SET name = ?, major = ?, email = ?
      WHERE id = ?
      `,
      [name, major, email, req.params.id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "ไม่พบข้อมูลนักศึกษา",
        },
      });
    }

    await invalidateStudentsCache();

    const [rows] = await pool.query("SELECT * FROM students WHERE id = ?", [
      req.params.id,
    ]);

    res.status(200).json({
      message: "แก้ไขข้อมูลสำเร็จ",
      data: rows[0],
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: {
          code: "DUPLICATE_EMAIL",
          message: "อีเมลนี้มีอยู่ในระบบแล้ว",
        },
      });
    }

    next(err);
  }
});

// =========================
// PATCH: แก้ไขบางฟิลด์
// =========================
v1Router.patch("/students/:id", async (req, res, next) => {
  const { name, major, email } = req.body;

  if (name === undefined && major === undefined && email === undefined) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "กรุณาระบุข้อมูลที่ต้องการแก้ไข",
      },
    });
  }

  try {
    const fields = [];
    const values = [];

    if (name !== undefined) {
      fields.push("name = ?");
      values.push(name);
    }

    if (major !== undefined) {
      fields.push("major = ?");
      values.push(major);
    }

    if (email !== undefined) {
      fields.push("email = ?");
      values.push(email);
    }

    values.push(req.params.id);

    const [result] = await pool.query(
      `UPDATE students SET ${fields.join(", ")} WHERE id = ?`,
      values,
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "ไม่พบข้อมูลนักศึกษา",
        },
      });
    }

    await invalidateStudentsCache();

    const [rows] = await pool.query("SELECT * FROM students WHERE id = ?", [
      req.params.id,
    ]);

    res.status(200).json({
      message: "แก้ไขข้อมูลสำเร็จ",
      data: rows[0],
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: {
          code: "DUPLICATE_EMAIL",
          message: "อีเมลนี้มีอยู่ในระบบแล้ว",
        },
      });
    }

    next(err);
  }
});

// =========================
// DELETE: ลบนักศึกษา (เฉพาะ admin)
// =========================
v1Router.delete(
  "/students/:id",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res, next) => {
    try {
      const [result] = await pool.query("DELETE FROM students WHERE id = ?", [
        req.params.id,
      ]);

      if (result.affectedRows === 0) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "ไม่พบข้อมูลนิสิต" },
        });
      }

      await invalidateStudentsCache();

      res.status(200).json({ message: "ลบข้อมูลสำเร็จ" });
    } catch (err) {
      next(err);
    }
  },
);

// =========================
// GET: รายวิชา
// =========================
v1Router.get("/courses/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM courses WHERE id = ?", [
      req.params.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "ไม่พบข้อมูลรายวิชา",
        },
      });
    }

    res.status(200).json({
      message: "สำเร็จ",
      data: rows[0],
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================================
// v2Router (skeleton สำหรับฝึกแนวคิด Versioning)
// ปรับรูปแบบผลลัพธ์ให้ต่างจาก v1: ไม่มี wrapper "message"
// ยังไม่มี pagination และ auth เหมือน v1 -- ระบบจริงต้องใส่ให้ครบ
// ==========================================================
v2Router.get("/students", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM students");
    res.status(200).json({ items: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

app.use("/api/v1", v1Router);
app.use("/api/v2", v2Router);

// Error handling middleware (จากสัปดาห์ที่ 4)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "เกิดข้อผิดพลาดภายในระบบ" },
  });
});

// =========================
// 404
// ต้องอยู่หลัง route ทั้งหมด
// =========================
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "ไม่พบเส้นทางที่ร้องขอ",
    },
  });
});

// =========================
// Error Handler
// =========================
app.use((err, req, res, next) => {
  console.error(err.stack);

  const statusCode = err.status || err.statusCode || 500;

  res.status(statusCode).json({
    error: {
      code: statusCode === 500 ? "INTERNAL_SERVER_ERROR" : err.type || "ERROR",
      message:
        statusCode === 500
          ? "เกิดข้อผิดพลาดที่ไม่คาดคิดภายในระบบ"
          : err.message,
    },
  });
});

module.exports = app;
