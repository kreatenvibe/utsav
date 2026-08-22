import { Router } from 'express';
import * as expenseService from '../services/expenseService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await expenseService.createExpense(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { festival_id, status } = req.query;
    res.json(await expenseService.listExpenses({ festival_id, status }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await expenseService.getExpense(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await expenseService.updateExpense(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await expenseService.deleteExpense(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
