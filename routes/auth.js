import { Router } from 'express';
import * as authService from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';

export const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    res.json(await authService.loginUser(req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/bootstrap', async (req, res, next) => {
  try {
    res.status(201).json(await authService.bootstrapFirstUser(req.body));
  } catch (err) {
    next(err);
  }
});

router.patch('/change-password', requireAuth, async (req, res, next) => {
  try {
    await authService.changePassword(req.user.user_id, req.body);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
