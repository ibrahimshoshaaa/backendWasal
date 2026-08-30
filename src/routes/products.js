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

// GET /api/products/:id/options — مجموعات الإضافات/الاختيارات المتاحة لمنتج معين
router.get('/:id/options', async (req, res) => {
  const { rows: groups } = await query(
    'SELECT * FROM option_groups WHERE product_id=$1 ORDER BY sort_order, id',
    [req.params.id]
  );
  const groupIds = groups.map((g) => g.id);
  let choices = [];
  if (groupIds.length) {
    const { rows } = await query(
      'SELECT * FROM option_choices WHERE group_id = ANY($1) AND is_available=true ORDER BY sort_order, id',
      [groupIds]
    );
    choices = rows;
  }
  res.json(groups.map((g) => ({ ...g, choices: choices.filter((c) => c.group_id === g.id) })));
});

module.exports = router;
