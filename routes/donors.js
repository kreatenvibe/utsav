import { Router } from 'express';
import multer from 'multer';
import * as donorService from '../services/donorService.js';

export const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await donorService.createDonor(req.body));
  } catch (err) {
    next(err);
  }
});

router.post(
  '/bulk',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        err.status = 400;
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      res.status(201).json(await donorService.bulkImportDonors(req.file));
    } catch (err) {
      next(err);
    }
  }
);

router.get('/', async (req, res, next) => {
  try {
    res.json(await donorService.listDonors({ search: req.query.search }));
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
