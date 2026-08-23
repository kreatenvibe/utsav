import { Router } from 'express';
import * as donationService from '../services/donationService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await donationService.createDonation(req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { donor_id, expected_id } = req.query;
    res.json(await donationService.listDonations({ donor_id, expected_id }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await donationService.getDonation(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await donationService.deleteDonation(req.params.id, req.user.user_id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
