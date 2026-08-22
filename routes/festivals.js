import { Router } from 'express';
import * as festivalService from '../services/festivalService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const festival = await festivalService.createFestival(req.body);
    res.status(201).json(festival);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await festivalService.listFestivals({ colony_id: req.query.colony_id }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await festivalService.getFestival(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await festivalService.updateFestival(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});
