import 'dotenv/config';
import express from 'express';
import { pool } from './db/pool.js';
import { requireAuth } from './middleware/auth.js';
import { router as authRouter } from './routes/auth.js';
import { router as coloniesRouter } from './routes/colonies.js';
import { router as festivalsRouter } from './routes/festivals.js';
import { router as membersRouter } from './routes/members.js';
import { router as donorsRouter } from './routes/donors.js';
import { router as expectedDonationsRouter } from './routes/expectedDonations.js';
import { router as donationsRouter } from './routes/donations.js';
import { router as expensesRouter } from './routes/expenses.js';
import { router as expensePaymentsRouter } from './routes/expensePayments.js';
import { router as tasksRouter } from './routes/tasks.js';
import { router as taskAssignmentsRouter } from './routes/taskAssignments.js';
import { router as availabilityRouter } from './routes/availability.js';

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/auth', authRouter);

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return requireAuth(req, res, next);
  }
  next();
});

app.use('/colonies', coloniesRouter);
app.use('/festivals', festivalsRouter);
app.use('/members', membersRouter);
app.use('/donors', donorsRouter);
app.use('/expected-donations', expectedDonationsRouter);
app.use('/donations', donationsRouter);
app.use('/expenses', expensesRouter);
app.use('/expense-payments', expensePaymentsRouter);
app.use('/tasks', tasksRouter);
app.use('/task-assignments', taskAssignmentsRouter);
app.use('/availability', availabilityRouter);

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
