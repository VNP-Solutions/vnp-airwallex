const express = require('express');
const c = require('../controllers/accessPortalController');
const { requireServiceToken } = require('../middleware/authMiddleware');

/**
 * VNP Access Portal contract v2, mounted at /api/access-portal/v1.
 *
 * Every route needs the portal's service token except:
 *   GET  /auth/handoff  public — a browser tab opens it, and it only redirects
 *   POST /auth/handoff  public, but only from this system's own origin
 *   GET  /auth/me       the PERSON's access token, which is what it checks
 *
 * /auth/login and /auth/refresh are behind the service token too: login takes
 * a password and returns tokens with nothing in between, so left open it would
 * be a password oracle over every account. This system's own sign-in page uses
 * /api/auth and is unaffected.
 */
const router = express.Router();

router.get('/auth/handoff', c.handoffGet);
router.post('/auth/handoff', c.handoffPost);
router.get('/auth/me', c.me);

router.post('/auth/login', requireServiceToken, c.login);
router.post('/auth/refresh', requireServiceToken, c.refresh);

router.get('/users', requireServiceToken, c.findUser);
router.post('/users', requireServiceToken, c.createUser);
router.get('/users/:id', requireServiceToken, c.getUser);
router.patch('/users/:id/password', requireServiceToken, c.setPassword);
router.patch('/users/:id/role', requireServiceToken, c.setRole);
router.patch('/users/:id/status', requireServiceToken, c.setStatus);

router.get('/roles', requireServiceToken, c.listRoles);

module.exports = router;
