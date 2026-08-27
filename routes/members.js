import { Router } from 'express';
import multer from 'multer';
import * as memberService from '../services/memberService.js';

export const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/', async (req, res, next) => {
  try {
    const member = await memberService.createMember(req.body, req.user.user_id);
    res.status(201).json(member);
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
      const result = await memberService.bulkImportMembers(
        { colony_id: req.body.colony_id, initial_password: req.body.initial_password, file: req.file },
        req.user.user_id
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

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

router.post('/:id/grant-login', async (req, res, next) => {
  try {
    res.status(201).json(await memberService.grantLogin(req.params.id, req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reset-password', async (req, res, next) => {
  try {
    res.json(await memberService.resetPassword(req.params.id, req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/colony-role', async (req, res, next) => {
  try {
    res.json(await memberService.setColonyRole(req.params.id, req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});
