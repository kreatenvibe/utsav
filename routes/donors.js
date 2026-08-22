import { Router } from 'express';
import * as donorService from '../services/donorService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await donorService.createDonor(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await donorService.listDonors());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await donorService.getDonor(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await donorService.updateDonor(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});
