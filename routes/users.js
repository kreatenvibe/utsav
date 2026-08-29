import { Router } from 'express';
import * as userService from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';

export const router = Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await userService.searchUsers({ search: req.query.search }));
  } catch (err) {
    next(err);
  }
});
