// students.test.js
require("dotenv").config();
const request = require("supertest");
const app = require("./app");
const pool = require("./db");
const { redisClient, connectRedis } = require("./cache");

describe("Students CRUD - /api/v1/students", () => {
  let createdId;
  let adminToken;

  beforeAll(async () => {
    // ต้องเชื่อมต่อ Redis เองก่อน เพราะไฟล์นี้ require("./app") ตรงๆ
    // ไม่ได้ผ่าน server.js ซึ่งเป็นที่เดียวที่ปกติเรียก connectRedis()
    await connectRedis();

    // สมัครสมาชิกปกติ (ได้ role student) แล้ว "เลื่อนขั้น" เป็น admin
    // ตรงผ่าน DB โดยตรง เพราะ /auth/register ไม่มีช่องให้กำหนด role
    const adminEmail = `admin${Date.now()}@example.com`;

    await request(app)
      .post("/api/v1/auth/register")
      .send({ email: adminEmail, password: "Passw0rd!" });

    await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [
      adminEmail,
    ]);

    const loginResponse = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: adminEmail, password: "Passw0rd!" });

    adminToken = loginResponse.body.token;
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  describe("GET /students", () => {
    test("ควรคืน 200 พร้อม data (array) และ pagination", async () => {
      const response = await request(app).get("/api/v1/students");

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.pagination).toHaveProperty("page");
      expect(response.body.pagination).toHaveProperty("totalPages");
    });
  });

  describe("POST /students", () => {
    test("ควรคืน 201 เมื่อข้อมูลครบถ้วน", async () => {
      const uniqueEmail = `student${Date.now()}@example.com`;

      const response = await request(app).post("/api/v1/students").send({
        name: "สมชาย ใจดี",
        major: "วิทยาการคอมพิวเตอร์",
        email: uniqueEmail,
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toHaveProperty("id");
      expect(response.body.data.email).toBe(uniqueEmail);

      createdId = response.body.data.id;
    });

    test("ควรคืน 400 เมื่อไม่ระบุ major", async () => {
      const response = await request(app)
        .post("/api/v1/students")
        .send({
          name: "สมหญิง รักเรียน",
          email: `incomplete${Date.now()}@example.com`,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    test("ควรคืน 409 เมื่อ email ซ้ำกับที่มีอยู่แล้ว", async () => {
      const duplicateEmail = `dup${Date.now()}@example.com`;

      await request(app).post("/api/v1/students").send({
        name: "คนแรก",
        major: "บัญชี",
        email: duplicateEmail,
      });

      const response = await request(app).post("/api/v1/students").send({
        name: "คนที่สอง",
        major: "บัญชี",
        email: duplicateEmail,
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("DUPLICATE_EMAIL");
    });
  });

  describe("GET /students/:id", () => {
    test("ควรคืน 200 เมื่อพบข้อมูล", async () => {
      const response = await request(app).get(`/api/v1/students/${createdId}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(createdId);
    });

    test("ควรคืน 404 เมื่อ id ไม่มีอยู่จริง", async () => {
      const response = await request(app).get("/api/v1/students/9999999");

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("PUT /students/:id", () => {
    test("ควรคืน 200 เมื่อแก้ไขข้อมูลสำเร็จ", async () => {
      const response = await request(app)
        .put(`/api/v1/students/${createdId}`)
        .send({
          name: "สมชาย ใจดี (แก้ไข)",
          major: "วิศวกรรมซอฟต์แวร์",
          email: `updated${Date.now()}@example.com`,
        });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe("สมชาย ใจดี (แก้ไข)");
    });

    test("ควรคืน 400 เมื่อข้อมูลไม่ครบ", async () => {
      const response = await request(app)
        .put(`/api/v1/students/${createdId}`)
        .send({ name: "ข้อมูลไม่ครบ" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    test("ควรคืน 404 เมื่อ id ไม่มีอยู่จริง", async () => {
      const response = await request(app)
        .put("/api/v1/students/9999999")
        .send({
          name: "ไม่มีจริง",
          major: "ไม่มีจริง",
          email: `notfound${Date.now()}@example.com`,
        });

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /students/:id", () => {
    test("ควรคืน 200 เมื่อแก้ไขบางฟิลด์สำเร็จ", async () => {
      const response = await request(app)
        .patch(`/api/v1/students/${createdId}`)
        .send({ major: "วิทยาศาสตร์ข้อมูล" });

      expect(response.status).toBe(200);
      expect(response.body.data.major).toBe("วิทยาศาสตร์ข้อมูล");
    });

    test("ควรคืน 400 เมื่อไม่ส่ง field ใดๆ มาเลย", async () => {
      const response = await request(app)
        .patch(`/api/v1/students/${createdId}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    test("ควรคืน 404 เมื่อ id ไม่มีอยู่จริง", async () => {
      const response = await request(app)
        .patch("/api/v1/students/9999999")
        .send({ major: "ไม่มีจริง" });

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /students/:id", () => {
    test("ควรคืน 401 เมื่อไม่แนบ token", async () => {
      const response = await request(app).delete(
        `/api/v1/students/${createdId}`,
      );

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("NO_TOKEN");
    });

    test("ควรคืน 200 เมื่อลบสำเร็จด้วย admin token", async () => {
      const response = await request(app)
        .delete(`/api/v1/students/${createdId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
    });

    test("ควรคืน 404 เมื่อ id ถูกลบไปแล้ว (ลบซ้ำ)", async () => {
      const response = await request(app)
        .delete(`/api/v1/students/${createdId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(404);
    });
  });
});
