import { Router } from 'express';
import * as taskAssignmentService from '../services/taskAssignmentService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await taskAssignmentService.createTaskAssignment(req.body, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { task_id, member_id } = req.query;
    res.json(await taskAssignmentService.listTaskAssignments({ task_id, member_id }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await taskAssignmentService.getTaskAssignment(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await taskAssignmentService.deleteTaskAssignment(req.params.id, req.user.user_id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
