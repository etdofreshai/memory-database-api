import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import messagesRouter from './routes/messages.js';
import sourcesRouter from './routes/sources.js';
import peopleRouter from './routes/people.js';
import statsRouter from './routes/stats.js';
import adminRouter from './routes/admin.js';
import ingestRouter from './routes/ingest.js';
import attachmentsRouter from './routes/attachments.js';
import linksRouter from './routes/links.js';
import enrichmentsRouter from './routes/enrichments.js';
import cleanupRouter from './routes/cleanup.js';

const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/health', healthRouter);
app.use('/api/messages/ingest', ingestRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/people', peopleRouter);
app.use('/api/stats', statsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/enrichments', enrichmentsRouter);
app.use('/api/links', linksRouter);
app.use('/api/cleanup', cleanupRouter);

export { app };
export default app;
