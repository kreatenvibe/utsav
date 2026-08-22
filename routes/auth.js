import { Router } from 'express';
import * as authService from '../services/authService.js';

export const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    res.status(201).json(await authService.registerUser(req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    res.json(await authService.loginUser(req.body));
  } catch (err) {
    next(err);
  }
});
