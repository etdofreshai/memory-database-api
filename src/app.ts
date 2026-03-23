import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import healthRouter from './routes/health.js';
import messagesRouter from './routes/messages.js';
import sourcesRouter from './routes/sources.js';
import peopleRouter from './routes/people.js';
import statsRouter from './routes/stats.js';
import adminRouter from './routes/admin.js';
import ingestRouter from './routes/ingest.js';
import attachmentsRouter from './routes/attachments.js';
import linksRouter from './routes/links.js';
import cleanupRouter from './routes/cleanup.js';
import discordChannelsRouter from './routes/discord-channels.js';
import chatgptRouter from './routes/chatgpt.js';
import imessageRouter from './routes/imessage.js';
import subscriptionSettingsRouter from './routes/subscription-settings.js';
import subscriptionsRouter from './routes/subscriptions.js';
import transactionsRouter from './routes/transactions.js';
import tasksRouter from './routes/tasks.js';

const app = express();

app.use(cors());
app.use(express.json());

// Serve static UI pages
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get('/tokens', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tokens.html'));
});
app.get('/imessage', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'imessage.html'));
});

// API routes
app.use('/api/health', healthRouter);
app.use('/api/messages/ingest', ingestRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/people', peopleRouter);
app.use('/api/stats', statsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/links', linksRouter);
app.use('/api/cleanup', cleanupRouter);
app.use('/api/discord/channels', discordChannelsRouter);
app.use('/api/chatgpt', chatgptRouter);
app.use('/api/imessage', imessageRouter);
app.use('/api/subscriptions/settings', subscriptionSettingsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/tasks', tasksRouter);

export { app };
export default app;
