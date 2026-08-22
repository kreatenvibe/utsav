import { Router } from 'express';
import * as availabilityService from '../services/availabilityService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await availabilityService.createAvailability(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { member_id, date } = req.query;
    res.json(await availabilityService.listAvailability({ member_id, date }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await availabilityService.getAvailability(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await availabilityService.updateAvailability(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await availabilityService.deleteAvailability(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
