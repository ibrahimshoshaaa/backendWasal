const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const { merchant_id } = req.query;
  let sql = 'SELECT * FROM products WHERE is_available=true';
  const params = [];
  if (merchant_id) {
    params.push(merchant_id);
    sql += ` AND merchant_id=$${params.length}`;
  }
  sql += ' ORDER BY id DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
});

module.exports = router;
