// 1. Add this line at the very top to load environment variables
require('dotenv').config();

const express = require("express");
const { Pool } = require("pg");

const app = express();
// 2. Corrected port definition: Use Render's PORT environment variable
const port = process.env.PORT || 3000;

// 3. Corrected database connection string: Use the name you set in Render
const pool = new Pool({
  connectionString: process.env.twdf_dashboard,
  ssl: {
    rejectUnauthorized: false
  }
});

// 4. Add a default route to prevent "Cannot GET /" error
app.get("/", (req, res) => {
  res.send("API is running!");
});

// 5. Add a new endpoint to check the database connection
app.get("/check_db", async (req, res) => {
  try {
    const result = await pool.query("SELECT current_database();");
    res.json({
      message: "Connected to database successfully!",
      database_name: result.rows[0].current_database
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to connect to database." });
  }
});

// Your API endpoint remains the same
app.get("/debtor_status_info", async (req, res) => {
  try {
    const { idcard, promise, province } = req.query;

    const conditions = ["ds.ds_status_project IN ('เปิดโครงการ','ระหว่างดำเนินคดี','ปิดโครงการ')"];
    const values = [];
    let idx = 1;

    if (idcard) {
      conditions.push(`w.wfri_id_card = $${idx}`);
      values.push(idcard);
      idx++;
    }

    if (promise) {
      conditions.push(`ds.ds_number_promise = $${idx}`);
      values.push(promise);
      idx++;
    }

    if (province) {
      conditions.push(`p.dpd_province = $${idx}`);
      values.push(province);
      idx++;
    }

    // 6. Corrected SQL query: Added 'public.' prefix to all table names
    const sql = `
      WITH ds_summary AS (
        SELECT
          ds.id,
          ds.ds_number_request,
          ds.ds_number_promise,
          ds.ds_name_year,
          ds.ds_project,
          ds.ds_status_project,
          ds.ds_rev_money,
          ds.ds_code_province,
          ds.ds_tambon,
          ds.remaining_principal,
          ds.remaining_interest,
          ds.remaining_fine,
          ds.remaining_interest_old_new,
          ds.remaining_sum
        FROM public.debtor_status_info ds
        WHERE ${conditions.join(" AND ")}
      ),
      valid_payment AS (
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
        FROM public.table_paid_money
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
        END AS "สถานะผู้กู้",
        ds.ds_project,
        ds.ds_status_project,
        ds.ds_rev_money,
        SUM(COALESCE(ds.remaining_principal, 0)) AS "เงินต้นคงเหลือ",
        COALESCE(pm.debt_not_due,0) AS "หนี้_ยังไม่ถึงกำหนด",
        SUM(COALESCE(ds.remaining_interest, 0)) AS "ดอกเบี้ยคงเหลือ",
        SUM(COALESCE(ds.remaining_fine, 0)) AS "เบี้ยปรับคงเหลือ",
        SUM(COALESCE(ds.remaining_interest_old_new, 0)) AS "ดอกเบี้ยผิดนัดคงเหลือ",
        SUM(COALESCE(ds.remaining_sum, 0)) AS "รวมคงเหลือ"
      FROM ds_summary ds
      JOIN public.money_revolving_project_record_info m
        ON m.id = ds.ds_number_request
      JOIN public.money_revolving_project_record_table r
        ON r.mrpr_tb_m2o_ref = m.id
      JOIN public.women_fund_register_info w
        ON w.id = r.mrpr_tb_id_card
      LEFT JOIN public.define_sub_district_data sdd
        ON sdd.id = ds.ds_tambon::INTEGER
      LEFT JOIN public.define_district_data ddd
        ON ddd.id = sdd.dsdd_district_ref
      LEFT JOIN public.define_province_data p
        ON ds.ds_code_province = p.id
      LEFT JOIN valid_payment pm
        ON pm.tpm_ref = ds.id
      GROUP BY
        w.wfri_id_card, w.wfri_full_name,
        p.dpd_province,
        ddd.ddd_district, sdd.dsdd_sub_district,
        ds.ds_name_year, ds.ds_number_promise,
        ds.ds_project, ds.ds_status_project,
        ds.ds_rev_money,
        r.mrpr_tb_position,
        pm.debt_not_due
      ORDER BY ds.ds_number_promise, r.mrpr_tb_position;
    `;

    const result = await pool.query(sql, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(port, () => {
  console.log(`✅ API server running at http://localhost:${port}`);
});
