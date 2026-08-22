import { Router } from 'express';
import * as taskService from '../services/taskService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await taskService.createTask(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { festival_id, status } = req.query;
    res.json(await taskService.listTasks({ festival_id, status }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await taskService.getTask(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await taskService.updateTask(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await taskService.deleteTask(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
