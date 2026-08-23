import { Router } from 'express';
import * as expectedDonationService from '../services/expectedDonationService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await expectedDonationService.createExpectedDonation(req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { festival_id, donor_id, status } = req.query;
    res.json(await expectedDonationService.listExpectedDonations({ festival_id, donor_id, status }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await expectedDonationService.getExpectedDonation(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await expectedDonationService.updateExpectedDonation(req.params.id, req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});
