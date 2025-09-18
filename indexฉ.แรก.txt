const express = require("express");
const { Pool } = require("pg");

const app = express();
const port = 3000;

// 👇 ตรงนี้แก้เป็นค่าของ PostgreSQL ของคุณเอง
const pool = new Pool({
  user: "postgres",      // username ของคุณ
  host: "172.17.101.108",     // หรือ IP ของ server PostgreSQL
  database: "dbTWFERP",    // ชื่อฐานข้อมูล maintenance database 
  password: "[m[kml9iu",  // รหัสผ่าน
  port: 4132,            // ค่า default
});

// API ทดสอบ: ดึงข้อมูลจากตาราง debtor_status_info
app.get("/debtor_status_info", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM debtor_status_info LIMIT 10;");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Database error");
  }
});

app.listen(port, () => {
  console.log(`✅ API server running at http://localhost:${port}`);
});
