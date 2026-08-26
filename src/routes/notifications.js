const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Notifications feature is deferred for now — this stub keeps the
// existing ApiService.getNotifications() call working without erroring.
router.get('/', requireAuth, async (req, res) => {
  res.json([]);
});

module.exports = router;
