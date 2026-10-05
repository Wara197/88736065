// app-coverage.test.js
// เป้าหมาย: ปิด branch ที่เหลือใน app.js ที่ auth.test.js / login-mocked.test.js /
// students.test.js / auth-middleware.test.js ยังไปไม่ถึง
require("dotenv").config();
const request = require("supertest");
const app = require("./app");
const pool = require("./db");
const { redisClient, connectRedis } = require("./cache");

describe("app.js - ปิด branch ที่เหลือ", () => {
  let studentId;
  let secondStudentId;
  let courseWithSeatsId;
  let courseFullId;

  beforeAll(async () => {
    await connectRedis();

    const [studentResult] = await pool.query(
      "INSERT INTO students (name, major, email) VALUES (?, ?, ?)",
      [
        "ทดสอบ Coverage",
        "วิศวกรรมคอมพิวเตอร์",
        `coverage${Date.now()}@example.com`,
      ],
    );
    studentId = studentResult.insertId;

    const [secondStudentResult] = await pool.query(
      "INSERT INTO students (name, major, email) VALUES (?, ?, ?)",
      [
        "ทดสอบ Coverage 2",
        "วิศวกรรมคอมพิวเตอร์",
        `coverage2${Date.now()}@example.com`,
      ],
    );
    secondStudentId = secondStudentResult.insertId;

    const [courseResult] = await pool.query(
      "INSERT INTO courses (course_name, credit, seat_available) VALUES (?, ?, ?)",
      [`Test Course ${Date.now()}`, 3, 5],
    );
    courseWithSeatsId = courseResult.insertId;

    const [fullCourseResult] = await pool.query(
      "INSERT INTO courses (course_name, credit, seat_available) VALUES (?, ?, ?)",
      [`Full Course ${Date.now()}`, 3, 0],
    );
    courseFullId = fullCourseResult.insertId;
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  // ปิด branch: !email || !password ที่ login (เดิมมีแค่ฝั่ง register)
  describe("POST /auth/login - branch เพิ่มเติม", () => {
    test("ควรคืน 400 เมื่อไม่ระบุ password", async () => {
      const response = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "someone@example.com" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    // ปิด branch: isPasswordValid === false (เดิมมีแค่ rows.length === 0)
    test("ควรคืน 401 เมื่อรหัสผ่านไม่ถูกต้อง (แต่ email ถูกต้อง)", async () => {
      const email = `wrongpass${Date.now()}@example.com`;
      await request(app)
        .post("/api/v1/auth/register")
        .send({ email, password: "Correct1!" });

      const response = await request(app)
        .post("/api/v1/auth/login")
        .send({ email, password: "WrongPassword!" });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });

  // ปิด branch: if (major) และ if (cached) ใน GET /students
  describe("GET /students - branch เพิ่มเติม", () => {
    test("ควรคืน 200 เมื่อกรองด้วย major", async () => {
      const response = await request(app).get(
        "/api/v1/students?major=วิศวกรรมคอมพิวเตอร์",
      );
      expect(response.status).toBe(200);
    });

    test("ควรคืนผลจาก cache เมื่อยิงซ้ำด้วยพารามิเตอร์เดิม", async () => {
      const query = "/api/v1/students?page=1&limit=5";
      await request(app).get(query); // ครั้งแรก: cache miss
      const response = await request(app).get(query); // ครั้งสอง: cache hit

      expect(response.status).toBe(200);
      expect(response.body.message).toContain("cache");
    });
  });

  // ปิด branch: studentRows.length === 0 ใน GET /students/:id/full (ยังไม่เคยถูกยิงเลย)
  describe("GET /students/:id/full", () => {
    test("ควรคืน 200 พร้อมรายวิชาที่ลงทะเบียน", async () => {
      const response = await request(app).get(
        `/api/v1/students/${studentId}/full`,
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data.courses)).toBe(true);
    });

    test("ควรคืน 404 เมื่อไม่พบนักศึกษา", async () => {
      const response = await request(app).get("/api/v1/students/9999999/full");
      expect(response.status).toBe(404);
    });
  });

  // ปิด branch ทั้งหมดของ transaction enrollment (ยังไม่เคยถูกยิงเลยทั้งบล็อก)
  describe("POST /students/:id/enrollments", () => {
    test("ควรคืน 400 เมื่อไม่ระบุ courseId", async () => {
      const response = await request(app)
        .post(`/api/v1/students/${studentId}/enrollments`)
        .send({});
      expect(response.status).toBe(400);
    });

    test("ควรคืน 404 เมื่อไม่พบรายวิชา (courseRows.length === 0)", async () => {
      const response = await request(app)
        .post(`/api/v1/students/${studentId}/enrollments`)
        .send({ courseId: 9999999 });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("COURSE_NOT_FOUND");
    });

    test("ควรคืน 409 เมื่อที่นั่งเต็ม (seat_available <= 0)", async () => {
      const response = await request(app)
        .post(`/api/v1/students/${studentId}/enrollments`)
        .send({ courseId: courseFullId });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("SEAT_FULL");
    });

    test("ควรคืน 201 เมื่อลงทะเบียนสำเร็จ (เส้นทางปกติ)", async () => {
      const response = await request(app)
        .post(`/api/v1/students/${studentId}/enrollments`)
        .send({ courseId: courseWithSeatsId });
      expect(response.status).toBe(201);
    });

    test("ควรคืน 409 เมื่อลงทะเบียนซ้ำวิชาเดิม (err.code === ER_DUP_ENTRY)", async () => {
      const response = await request(app)
        .post(`/api/v1/students/${studentId}/enrollments`)
        .send({ courseId: courseWithSeatsId });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ALREADY_ENROLLED");
    });
  });

  // ปิด branch: err.code === ER_DUP_ENTRY ตอนแก้ไข (PUT/PATCH) ซึ่งเดิมมีแค่ตอนสร้างใหม่ (POST)
  describe("PUT / PATCH /students/:id - branch ซ้ำอีเมล", () => {
    test("PUT ควรคืน 409 เมื่อแก้ email ให้ซ้ำกับคนอื่น", async () => {
      const [existing] = await pool.query(
        "SELECT email FROM students WHERE id = ?",
        [studentId],
      );

      const response = await request(app)
        .put(`/api/v1/students/${secondStudentId}`)
        .send({
          name: "ชื่อใดก็ได้",
          major: "สาขาใดก็ได้",
          email: existing[0].email,
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("DUPLICATE_EMAIL");
    });

    test("PATCH ควรคืน 409 เมื่อแก้ email ให้ซ้ำกับคนอื่น", async () => {
      const [existing] = await pool.query(
        "SELECT email FROM students WHERE id = ?",
        [studentId],
      );

      const response = await request(app)
        .patch(`/api/v1/students/${secondStudentId}`)
        .send({ email: existing[0].email });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("DUPLICATE_EMAIL");
    });
  });

  // ปิด branch: GET /courses/:id (ยังไม่เคยถูกยิงเลยทั้งเส้นทาง)
  describe("GET /courses/:id", () => {
    test("ควรคืน 200 เมื่อพบรายวิชา", async () => {
      const response = await request(app).get(
        `/api/v1/courses/${courseWithSeatsId}`,
      );
      expect(response.status).toBe(200);
    });

    test("ควรคืน 404 เมื่อไม่พบรายวิชา", async () => {
      const response = await request(app).get("/api/v1/courses/9999999");
      expect(response.status).toBe(404);
    });
  });

  // ปิด branch: v2Router (ยังไม่เคยถูกยิงเลย)
  describe("GET /api/v2/students", () => {
    test("ควรคืน 200 พร้อม items และ count", async () => {
      const response = await request(app).get("/api/v2/students");
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("items");
      expect(response.body).toHaveProperty("count");
    });
  });

  // ปิด branch: 404 handler ท้ายไฟล์ (ยังไม่เคยถูกยิงเลย)
  describe("Route ที่ไม่มีอยู่จริง", () => {
    test("ควรคืน 404 พร้อม ROUTE_NOT_FOUND", async () => {
      const response = await request(app).get("/api/v1/does-not-exist");
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("ROUTE_NOT_FOUND");
    });
  });
});
