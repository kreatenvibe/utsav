import { Router } from 'express';
import * as expensePaymentService from '../services/expensePaymentService.js';

export const router = Router();

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await expensePaymentService.createExpensePayment(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { expense_id } = req.query;
    res.json(await expensePaymentService.listExpensePayments({ expense_id }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await expensePaymentService.getExpensePayment(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await expensePaymentService.deleteExpensePayment(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
