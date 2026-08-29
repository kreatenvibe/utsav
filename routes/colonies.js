import { Router } from 'express';
import * as colonyService from '../services/colonyService.js';
import * as membershipService from '../services/colonyMembershipService.js';
import { requireAuth } from '../middleware/auth.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const colony = await colonyService.createColony(req.body, req.user.user_id);
    res.status(201).json(colony);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await colonyService.listColonies({ search: req.query.search }));
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    res.json(await membershipService.listMyColonies(req.user.user_id));
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
    res.json(await colonyService.updateColony(req.params.id, req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/members', requireAuth, async (req, res, next) => {
  try {
    await colonyService.getColony(req.params.id);
    res.json(await membershipService.listColonyMembers(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/members', async (req, res, next) => {
  try {
    await colonyService.getColony(req.params.id);
    const member = await membershipService.addMember(req.params.id, req.user.user_id, req.body);
    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/members/:userId', async (req, res, next) => {
  try {
    await colonyService.getColony(req.params.id);
    const member = await membershipService.updateMemberRole(
      req.params.id,
      req.user.user_id,
      req.params.userId,
      req.body.role
    );
    res.json(member);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    await colonyService.getColony(req.params.id);
    await membershipService.removeMember(req.params.id, req.user.user_id, req.params.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
