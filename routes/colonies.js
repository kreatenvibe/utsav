import { Router } from 'express';
import * as colonyService from '../services/colonyService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const colony = await colonyService.createColony(req.body);
    res.status(201).json(colony);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await colonyService.listColonies());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await colonyService.getColony(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await colonyService.updateColony(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});
