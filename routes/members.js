import { Router } from 'express';
import * as memberService from '../services/memberService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const member = await memberService.createMember(req.body, req.user.user_id);
    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await memberService.listMembers({ colony_id: req.query.colony_id }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await memberService.getMember(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await memberService.updateMember(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});
