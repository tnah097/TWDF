require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ API is running. Use /debtor_status_info for queries.");
});

// API ดึงข้อมูล debtor_status_info
// ✨ อัปเกรดแล้ว: รองรับการทำงาน 2 โหมด (ปกติ และ Batch)
app.get("/debtor_status_info", async (req, res) => {
  // ✨ การแก้ไข #1: จัดการ Connection Client ด้วยตัวเองเพื่อความเสถียรสูงสุด
  // เราจะ "ยืม" การเชื่อมต่อ (client) มา 1 เส้นเพื่อทำงานนี้โดยเฉพาะ
  const client = await pool.connect();

  try {
    // =================================================================
    //   เงื่อนไขใหม่: Batch Processing Mode (ทำงานเร็วขึ้น)
    // =================================================================
    // ตรวจสอบว่ามีการส่ง query parameter 'promises' (มี s) มาหรือไม่
    if (req.query.promises) {
      console.log("🚀 Engaging Batch Mode...");

      // 1. แปลง String ที่คั่นด้วย comma ให้กลายเป็น Array ของเลขที่สัญญา
      const promiseArray = req.query.promises.split(',');

      // 2. สร้าง SQL Query ที่ปลอดภัยและมีประสิทธิภาพสำหรับการค้นหาเป็นชุด
      // โดยใช้ความสามารถของ PostgreSQL ในการรับ Array เป็น parameter โดยตรง
      const batchSql = `
        SELECT 
          ds.ds_number_promise,
          ds.remaining_principal AS "เงินต้นคงเหลือ",
          COALESCE(vp.debt_not_due, 0) AS "หนี้ยังไม่ถึงกำหนด"
        FROM debtor_status_info ds
        LEFT JOIN (
          SELECT
            tpm_ref,
            SUM(
              CASE
                WHEN (tpm_end_paid + INTERVAL '5 day') >= CURRENT_DATE AND COALESCE(tpm_re_money, 0) = 0
                THEN tpm_paid_principle
                WHEN (tpm_end_paid + INTERVAL '5 day') >= CURRENT_DATE AND tpm_paid_principle > COALESCE(tpm_re_money, 0)
                THEN tpm_paid_principle - tpm_re_money
                ELSE 0
              END
            ) AS debt_not_due
          FROM table_paid_money
          WHERE tmp_paystatus IS DISTINCT FROM 'Canceled'
          GROUP BY tpm_ref
        ) vp ON ds.id = vp.tpm_ref
        WHERE ds.ds_number_promise = ANY($1::text[])
      `;

      // 3. ส่ง Array ทั้งหมดเข้าไปเป็น Parameter เพียงตัวเดียว ($1)
      // ✨ การแก้ไข #1 (ต่อ): ใช้ client ที่ยืมมาในการ query
      const result = await client.query(batchSql, [promiseArray]);

      // 4. ส่งผลลัพธ์ทั้งหมดกลับไป
      return res.json(result.rows);
    }

    // =================================================================
    //   เงื่อนไขเดิม: Normal Mode (ทำงานทีละรายการ)
    // =================================================================
    // ถ้าไม่มี 'promises' ให้ทำงานตาม Logic เดิมทั้งหมด
    const { idcard, promise, province } = req.query;

    // เงื่อนไข dynamic (คงเดิม)
    const conditions = ["ds.ds_status_project IN ('เปิดโครงการ','ระหว่างดำเนินคดี','ปิดโครงการ')"];
    const values = [];
    let idx = 1;

    if (idcard) {
      conditions.push(`TRIM(w.wfri_id_card) = $${idx}`);
      values.push(idcard.trim());
      idx++;
    }
    if (promise) {
      conditions.push(`TRIM(ds.ds_number_promise) = $${idx}`);
      values.push(promise.trim());
      idx++;
    }
    if (province) {
      conditions.push(`TRIM(p.dpd_province) ILIKE $${idx}`);
      values.push(`%${province.trim()}%`); // แก้ไขให้ค้นหาแบบ case-insensitive และบางส่วน
      idx++;
    }

    // สร้าง WHERE clause แบบปลอดภัย (คงเดิม)
    const whereClause = conditions.length > 1 ? "WHERE " + conditions.join(" AND ") : "WHERE " + conditions[0];

    const sql = `
      WITH valid_payment AS (
        SELECT
          tpm_ref,
          SUM(
            CASE
              WHEN (tpm_end_paid + INTERVAL '5 day') >= CURRENT_DATE
                  AND COALESCE(tpm_re_money, 0) = 0
              THEN tpm_paid_principle
              WHEN (tpm_end_paid + INTERVAL '5 day') >= CURRENT_DATE
                  AND tpm_paid_principle > COALESCE(tpm_re_money, 0)
              THEN tpm_paid_principle - tpm_re_money
              ELSE 0
            END
          ) AS debt_not_due
        FROM table_paid_money
        WHERE tmp_paystatus IS DISTINCT FROM 'Canceled'
        GROUP BY tpm_ref
      )
      SELECT
        w.wfri_id_card,
        w.wfri_full_name,
        p.dpd_province,
        ddd.ddd_district,
        sdd.dsdd_sub_district,
        ds.ds_name_year,
        ds.ds_number_promise,
        CASE WHEN r.mrpr_tb_position = 'position_1'
            THEN 'ผู้แทนกลุ่ม เสนอโครงการ'
            ELSE 'ผู้ร่วมโครงการ'
        END AS สถานะผู้กู้,
        ds.ds_project,
        ds.ds_status_project,
        ds.ds_rev_money,

        -- ✨ การแก้ไข #2: เปลี่ยนจาก SUM() เป็น MAX() เพื่อป้องกันการบวกยอดซ้ำซ้อน
        MAX(COALESCE(ds.remaining_principal,0)) AS "เงินต้นคงเหลือ",
        COALESCE(pm.debt_not_due,0) AS "หนี้ยังไม่ถึงกำหนด",
        MAX(COALESCE(ds.remaining_interest,0)) AS "ดอกเบี้ยคงเหลือ",
        MAX(COALESCE(ds.remaining_fine,0)) AS "เบี้ยปรับคงเหลือ",
        MAX(COALESCE(ds.remaining_interest_old_new,0)) AS "ดอกเบี้ยผิดนัดคงเหลือ",
        MAX(COALESCE(ds.remaining_sum,0)) AS "รวมคงเหลือ"

      FROM debtor_status_info ds
      LEFT JOIN money_revolving_project_record_info m ON m.id = ds.ds_number_request
      LEFT JOIN money_revolving_project_record_table r ON r.mrpr_tb_m2o_ref = m.id
      LEFT JOIN women_fund_register_info w ON w.id = r.mrpr_tb_id_card
      LEFT JOIN define_sub_district_data sdd ON sdd.id = ds.ds_tambon::INTEGER
      LEFT JOIN define_district_data ddd ON ddd.id = sdd.dsdd_district_ref
      LEFT JOIN define_province_data p ON ds.ds_code_province = p.id
      LEFT JOIN valid_payment pm ON pm.tpm_ref = ds.id
      ${whereClause}
      GROUP BY
        w.wfri_id_card, w.wfri_full_name,
        p.dpd_province,
        ddd.ddd_district, sdd.dsdd_sub_district,
        ds.ds_name_year, ds.ds_number_promise,
        ds.ds_project, ds.ds_status_project,
        ds.ds_rev_money,
        r.mrpr_tb_position,
        pm.debt_not_due,
        ds.id -- เพิ่ม ds.id เข้าไปใน group by เพื่อความถูกต้องของ COALESCE(pm.debt_not_due,0)
      ORDER BY ds.ds_number_promise, r.mrpr_tb_position;
    `;
    
    // ✨ การแก้ไข #1 (ต่อ): ใช้ client ที่ยืมมาในการ query
    const result = await client.query(sql, values);
    res.json(result.rows);

  } catch (err) {
    console.error("❌ Query Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    // ✨ การแก้ไข #1 (ต่อ): "คืน" การเชื่อมต่อ (client) กลับเข้า Pool เสมอ
    // ไม่ว่างานจะสำเร็จหรือล้มเหลว เพื่อป้องกัน Connection รั่วไหล
    if (client) {
      client.release();
    }
  }
});

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ API server (Stable & Batch Ready) running on port ${port}`);
});

